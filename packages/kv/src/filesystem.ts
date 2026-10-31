import {
  EMPTY,
  Holds,
  type State,
  commitTo,
  holdsLayer,
  scanState,
  valueAt,
} from './engine.js';
import { Effect, Layer, Match, Option, Ref, Schema, Semaphore } from 'effect';
import type { Key, OpMap, ScanOptions, Sequence } from './types.js';
import { KvUnavailable, SnapshotExpired, deleteOp, putOp } from './types.js';
import { mkdir, open } from 'node:fs/promises';
import { Kv } from './kv.js';
import { join } from 'node:path';

/** One write in the log: a base64 body, or `null` for a tombstone. */
interface WalWrite {
  readonly key: Key;
  readonly value: string | null;
}

/** One committed batch as it rests on disk; the line's order is its sequence. */
interface WalRecord {
  readonly writes: ReadonlyArray<WalWrite>;
}

const LOG_FILE = 'kv.log';

const WalRecordSchema = Schema.Struct({
  writes: Schema.Array(
    Schema.Struct({ key: Schema.String, value: Schema.NullOr(Schema.String) }),
  ),
});

/** A log line is our own format, but the file is still outside our control. */
const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(WalRecordSchema),
);

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(WalRecordSchema));

/** The ops a batch asked for, with every precondition already satisfied. */
const toRecord = (ops: ReadonlyArray<OpMap>) => ({
  writes: ops.map((op) =>
    Match.value(op).pipe(
      Match.tagsExhaustive({
        put: (write) => ({
          key: write.key,
          value: Buffer.from(write.value).toString('base64'),
        }),
        delete: (gone) => ({ key: gone.key, value: null }),
      }),
    ),
  ),
});

/** Replay one record: the same commit, its preconditions already proven. */
const applyRecord = (state: State, record: WalRecord) => {
  const result = commitTo(
    state,
    record.writes.map((write) =>
      write.value === null
        ? deleteOp({ key: write.key })
        : putOp({
            key: write.key,
            value: new Uint8Array(Buffer.from(write.value, 'base64')),
          }),
    ),
  );
  return Match.value(result).pipe(
    Match.tag('committed', (done) => done.state),
    Match.orElse(() => state),
  );
};

/**
 * The records of a log file, in order. A torn tail — the last line of a crash
 * mid-append — is dropped, because the commit that wrote it was never
 * acknowledged. A torn line anywhere else is corruption, and is not.
 */
const parseRecords = (contents: string) => {
  const lines = contents.split('\n');
  const records: WalRecord[] = [];
  lines.forEach((line, index) => {
    if (line === '') {
      return;
    }
    const decoded = decodeRecord(line);
    if (Option.isSome(decoded)) {
      records.push(decoded.value);
      return;
    }
    if (index !== lines.length - 1) {
      throw new Error(`the log is corrupt at line ${index + 1}`);
    }
  });
  return records;
};

/**
 * The filesystem backend — the same contract over a directory, and the one
 * that survives a restart: every accepted batch is appended and fsynced before
 * it is acknowledged, and the log is replayed on the way back up.
 */
export const kvFilesystemLayer = (directory: string) =>
  Layer.effect(
    Kv,
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(directory, { recursive: true });
            return await open(join(directory, LOG_FILE), 'a+');
          },
          catch: (cause) => new KvUnavailable({ message: String(cause) }),
        }),
        (opened) => Effect.promise(() => opened.close()),
      );

      const records = yield* Effect.tryPromise({
        try: async () =>
          parseRecords(await handle.readFile({ encoding: 'utf8' })),
        catch: (cause) => new KvUnavailable({ message: String(cause) }),
      });

      const state = yield* Ref.make(records.reduce(applyRecord, EMPTY));
      const lock = yield* Semaphore.make(1);
      const holds = yield* Holds;

      const within = (moment: Sequence, oldest: Sequence) =>
        moment < oldest
          ? Effect.fail(new SnapshotExpired({ at: moment, oldest }))
          : Effect.void;

      // ponytail: one writer at a time, and the whole log is replayed into
      // memory — the object-store backend under the LSM is where concurrency
      // and compaction arrive.
      const commit = (ops: ReadonlyArray<OpMap>) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const result = commitTo(current, ops);
            return yield* Match.value(result).pipe(
              Match.tagsExhaustive({
                rejected: (bad) => Effect.fail(bad.error),
                committed: (done) =>
                  Effect.tryPromise({
                    try: async () => {
                      await handle.write(`${encodeRecord(toRecord(ops))}\n`);
                      await handle.sync();
                    },
                    catch: (cause) =>
                      new KvUnavailable({ message: String(cause) }),
                  }).pipe(
                    Effect.andThen(Ref.set(state, done.state)),
                    Effect.as(done.state.sequence),
                  ),
              }),
            );
          }),
        );

      return Kv.of({
        sequence: Ref.get(state).pipe(
          Effect.map((current) => current.sequence),
        ),

        get: (key, at) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const moment = at ?? current.sequence;
            yield* within(moment, yield* holds.watermark(current.sequence));
            return Option.map(valueAt(current.log, key, moment), (found) => ({
              key,
              value: found.value,
              version: found.version,
            }));
          }),

        getMany: (keys, at) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const moment = at ?? current.sequence;
            yield* within(moment, yield* holds.watermark(current.sequence));
            return keys.flatMap((key) =>
              Option.toArray(valueAt(current.log, key, moment)).map(
                (found) => ({
                  key,
                  value: found.value,
                  version: found.version,
                }),
              ),
            );
          }),

        put: (key, value, condition) =>
          commit([
            condition === undefined
              ? putOp({ key, value })
              : putOp({ key, value, condition }),
          ]),

        delete: (key, condition) =>
          commit([
            condition === undefined
              ? deleteOp({ key })
              : deleteOp({ key, condition }),
          ]),

        batch: commit,

        scan: (options: ScanOptions | undefined) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const page = yield* scanState(current, options);
            yield* within(page.at, yield* holds.watermark(current.sequence));
            return page;
          }),

        snapshot: (at) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const wanted = at ?? current.sequence;
            yield* within(wanted, yield* holds.watermark(current.sequence));
            return yield* holds.snapshot(wanted);
          }),
      });
    }),
  ).pipe(Layer.provide(holdsLayer));
