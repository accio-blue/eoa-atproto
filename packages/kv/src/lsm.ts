import {
  type BlockEntry,
  type RunIndex,
  blockHolding,
  blocksOf,
  decodeBlock,
  decodeIndex,
  encodeBlock,
  encodeIndex,
  indexName,
  toBlocks,
} from './run.js';
import {
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  Semaphore,
} from 'effect';
import {
  type Cursor,
  DEFAULT_LIMIT,
  Holds,
  type Log,
  type Versioned,
  conditionHolds,
  decodeCursor,
  encodeCursor,
  evict,
  holdsLayer,
} from './engine.js';
import {
  CursorInvalid,
  KeyPreconditionFailed,
  KvUnavailable,
  SnapshotExpired,
  deleteOp,
  putOp,
} from './types.js';
import type {
  Key,
  KvError,
  OpMap,
  ScanOptions,
  Sequence,
  Value,
} from './types.js';
import { type LeaseError, ShardLease, leaseName } from './lease.js';
import { ObjectStore, ifAbsent } from '@eoa/object-store';
import { Kv } from './kv.js';
import type { ObjectStoreError } from '@eoa/object-store';

/** How many un-compacted batches are tolerated before a flush. */
const DEFAULT_THRESHOLD = 16;

const LOG_PREFIX = 'log/';
const SST_PREFIX = 'sst/';

/** How many runs a level tolerates before it is merged into the next one. */
const DEFAULT_TIER = 4;

/** How many blocks a read may keep in memory before the oldest is let go. */
const DEFAULT_BLOCK_CACHE = 256;

/** Padded, so the store's lexicographic order is the sequence order. */
const pad = (value: number) => String(value).padStart(16, '0');

const logName = (sequence: Sequence) => `${LOG_PREFIX}${pad(sequence)}`;

const sequenceOfLog = (name: string) => Number(name.slice(LOG_PREFIX.length));

const toBase64 = (value: Value) => Buffer.from(value).toString('base64');

const fromBase64 = (value: string) =>
  new Uint8Array(Buffer.from(value, 'base64'));

/** One accepted batch, as it rests in a log object. */
const LogRecord = Schema.Struct({
  writes: Schema.Array(
    Schema.Struct({ key: Schema.String, value: Schema.NullOr(Schema.String) }),
  ),
});

const decodeLog = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecord));
const encodeLog = Schema.encodeSync(Schema.fromJsonString(LogRecord));

/** One versioned write, as a run's blocks carry it. */
type Entry = BlockEntry;

/** The store's errors, told in the KV's terms. */
const asKvError = (key: Key, error: ObjectStoreError) =>
  Match.value(error).pipe(
    Match.tag(
      'PreconditionFailed',
      () => new KeyPreconditionFailed({ key, expected: 'absent' }),
    ),
    Match.orElse(
      (other) => new KvUnavailable({ message: `${key}: ${other.message}` }),
    ),
  );

/** The lease's errors, told in the KV's terms: a fenced writer fails a precondition. */
const asLeaseError = (shard: string, error: LeaseError) =>
  Match.value(error).pipe(
    Match.tag(
      'ObjectStoreUnavailable',
      (unreachable) => new KvUnavailable({ message: unreachable.message }),
    ),
    Match.orElse(
      () =>
        new KeyPreconditionFailed({
          key: leaseName(shard),
          expected: 'the lease',
        }),
    ),
  );

/** The newer of two versions, or whichever there is. */
const newestOf = (left: Versioned | undefined, right: Versioned | undefined) =>
  left === undefined
    ? right
    : right === undefined
      ? left
      : right.version > left.version
        ? right
        : left;

/** A tombstone is an answer too — just not a value. */
const live = (newest: Versioned | undefined) =>
  newest === undefined || newest.value === undefined
    ? Option.none<{ readonly version: Sequence; readonly value: Value }>()
    : Option.some({ version: newest.version, value: newest.value });

/**
 * The newest version of `key` at or below `at` — across the memtable and the
 * run. A tombstone in either shadows a value in the other, which is why both
 * sides are asked for their *newest* version rather than their newest value.
 */
const resolveKey = (
  tail: Log,
  run: ReadonlyArray<Entry>,
  key: Key,
  at: Sequence,
) =>
  live(
    newestOf(
      (tail.get(key) ?? []).filter((entry) => entry.version <= at).at(-1),
      run
        .filter((entry) => entry.key === key && entry.version <= at)
        .sort((left, right) => right.version - left.version)
        .at(0),
    ),
  );

/** Fold a run and the memtable into one log, each key's versions in order. */
const mergeEntries = (run: ReadonlyArray<Entry>, tail: Log) => {
  const merged = new Map<Key, Array<Versioned>>();
  for (const entry of run) {
    merged.set(entry.key, [
      ...(merged.get(entry.key) ?? []),
      { version: entry.version, value: entry.value },
    ]);
  }
  for (const [key, versions] of tail) {
    merged.set(key, [...(merged.get(key) ?? []), ...versions]);
  }
  return new Map(
    [...merged].map(([key, versions]) => [
      key,
      versions.sort((left, right) => left.version - right.version),
    ]),
  );
};

/** A log, as the entries a block holds: in key order, then version. */
const asBlockEntries = (log: Log) =>
  [...log]
    .flatMap(([key, versions]) =>
      versions.map((entry) => ({
        key,
        version: entry.version,
        value: entry.value,
      })),
    )
    .sort((left, right) =>
      left.key === right.key
        ? left.version - right.version
        : left.key < right.key
          ? -1
          : 1,
    );

/**
 * Rebuild the memtable from the store. The **manifest is the listing**: the
 * run it names stays on the bucket — only the un-compacted log objects are
 * folded in, which is what keeps memory to the size of the tail rather than
 * the size of the repo.
 */
const recover = (objects: ObjectStore['Service']) =>
  Effect.gen(function* () {
    // Every page: a bucket lists in pages (R2 and S3 stop at 1000), and a recovery that read only
    // the first would drop the objects after it -- the newest log, a run -- without a word.
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* objects
        .list(cursor === undefined ? {} : { cursor })
        .pipe(Effect.mapError((error) => asKvError(LOG_PREFIX, error)));
      keys.push(...page.keys);
      cursor = page.cursor;
    } while (cursor !== undefined);

    const mine = keys
      .filter(
        (name) => name.startsWith(LOG_PREFIX) || name.startsWith(SST_PREFIX),
      )
      .sort();
    const indexes = mine.filter((name) => name.startsWith(SST_PREFIX));
    const logs = mine.filter((name) => name.startsWith(LOG_PREFIX));

    const runs = yield* Effect.forEach(indexes, (name) =>
      objects.get(name).pipe(
        Effect.mapError((error) => asKvError(name, error)),
        Effect.flatMap((found) => {
          if (Option.isNone(found)) {
            return Effect.fail(
              new KvUnavailable({
                message: `${name} vanished while recovering`,
              }),
            );
          }
          const decoded = decodeIndex(
            new TextDecoder().decode(found.value.body),
          );
          return Option.isNone(decoded)
            ? Effect.fail(
                new KvUnavailable({ message: `${name} could not be read` }),
              )
            : Effect.succeed(decoded.value);
        }),
      ),
    );

    const parts = yield* Effect.forEach(logs, (name) =>
      objects.get(name).pipe(
        Effect.mapError((error) => asKvError(name, error)),
        Effect.flatMap((found) => {
          if (Option.isNone(found)) {
            return Effect.fail(
              new KvUnavailable({
                message: `${name} vanished while recovering`,
              }),
            );
          }
          const decoded = decodeLog(new TextDecoder().decode(found.value.body));
          return Option.isNone(decoded)
            ? Effect.fail(
                new KvUnavailable({ message: `${name} could not be read` }),
              )
            : Effect.succeed({
                name,
                writes: decoded.value.writes,
              });
        }),
      ),
    );

    const tail = new Map<Key, Array<Versioned>>();
    for (const part of parts) {
      for (const write of part.writes) {
        tail.set(write.key, [
          ...(tail.get(write.key) ?? []),
          {
            version: sequenceOfLog(part.name),
            value: write.value === null ? undefined : fromBase64(write.value),
          },
        ]);
      }
    }

    return {
      tail,
      runs,
      flushed: runs.reduce((highest, run) => Math.max(highest, run.to), 0),
      sequence: Math.max(
        runs.reduce((highest, run) => Math.max(highest, run.to), 0),
        ...logs.map((name) => sequenceOfLog(name)),
        0,
      ),
    };
  });

export interface LsmOptions {
  /** How many un-compacted batches are tolerated before a flush. */
  readonly threshold?: number;
  /** How many runs a level tolerates before it is merged into the next one. */
  readonly tier?: number;
  /** How many blocks a read may keep in memory before the oldest is let go. */
  readonly blockCache?: number;
  /**
   * Take this shard on the way up and fence every write with its epoch
   * (`xk5v`). Without it the LSM runs unleased — which is development and the
   * tests, not a deployment.
   */
  readonly lease?: { readonly shard: string; readonly owner: string };
}

/**
 * What the store knows about itself, for the gauges (ADR 0009, ticket `rohy`).
 *
 * These are read *from* the store rather than counted outside it: a count kept
 * by the app drifts from the store the moment the process restarts, and a gauge
 * that lies is worse than no gauge.
 */
export interface StoreStats {
  /** The head sequence — the newest write the store holds. */
  readonly sequence: Sequence;
  /** How many runs rest at each level. */
  readonly runsByLevel: ReadonlyArray<{
    readonly level: number;
    readonly runs: number;
  }>;
  /** How many snapshots readers hold right now. */
  readonly heldSnapshots: number;
  /** How many blocks the read cache holds. */
  readonly blockCacheEntries: number;
}

/**
 * The LSM's own shape, alongside the `Kv` it provides. Only the LSM has runs
 * and a block cache, so this is not on the `Kv` seam: a backend that has none
 * has nothing to say here.
 */
export class LsmStats extends Context.Service<
  LsmStats,
  { readonly read: Effect.Effect<StoreStats> }
>()('@eoa/kv/LsmStats') {}

/**
 * The LSM's two faces from one build — the store, and what it knows about
 * itself. They must be the same instance: the stats read the store's own refs.
 */
class Lsm extends Context.Service<
  Lsm,
  { readonly kv: Kv['Service']; readonly stats: LsmStats['Service'] }
>()('@eoa/kv/Lsm') {}

/**
 * The object-store backend of the KV seam: an LSM. A batch is **one object**,
 * named by its sequence and claimed with a conditional PUT, so visibility is a
 * single write with nothing to make consistent (the Effect-PDS map, `x64n`).
 *
 * Memory holds the **memtable** — the un-compacted tail — and nothing else. The
 * run lives on the bucket and is read back on demand, merged with the memtable
 * on the way out, so a repo's history costs bucket reads rather than heap. The
 * listing is the manifest a snapshot reads.
 *
 * The two latency ceilings `d9hk` marked are gone, both by way of the run
 * format (`6zri`): a run is a **sparse index** plus **blocks**, so a read is a
 * seek and a block is the unit that gets cached; and a flush writes the memtable
 * as a run of its own, with **size-tiered** merging above it, so a flush costs
 * the tail rather than the repo.
 *
 * The sequence is still allocated *locally* here; the shard's lease supplies it
 * and fences stale writers in `xk5v`.
 *
 * `log/`, `sst/` and `blk/` are the whole namespace this backend reads, so a
 * co-tenant's keys — a `leases/` object, say — are ignored rather than
 * misread. One LSM per bucket (or a bucket per shard); a prefix for
 * co-tenancy would be the way to put several shards in one.
 */
const lsmFaces = (options: LsmOptions) =>
  Layer.effect(
    Lsm,
    Effect.gen(function* () {
      const objects = yield* ObjectStore;
      const threshold = options.threshold ?? DEFAULT_THRESHOLD;
      const bounds = options.lease;
      const shardLease = yield* ShardLease;
      const held =
        bounds === undefined
          ? undefined
          : yield* shardLease
              .acquire(bounds.shard, bounds.owner)
              .pipe(
                Effect.mapError((error) => asLeaseError(bounds.shard, error)),
              );
      const recovered = yield* recover(objects);
      const state = yield* Ref.make(recovered.tail);
      const current = yield* Ref.make(recovered.sequence);
      const runs = yield* Ref.make(recovered.runs);
      const flushed = yield* Ref.make(recovered.flushed);
      const cache = yield* Ref.make(
        new Map<string, ReadonlyArray<BlockEntry>>(),
      );
      const lock = yield* Semaphore.make(1);
      const holds = yield* Holds;
      const tier = options.tier ?? DEFAULT_TIER;
      const cacheBlocks = options.blockCache ?? DEFAULT_BLOCK_CACHE;

      const within = (moment: Sequence, oldest: Sequence) =>
        moment < oldest
          ? Effect.fail(new SnapshotExpired({ at: moment, oldest }))
          : Effect.void;

      /**
       * One block, from memory when it is there.
       *
       * This is the half of the run format that pays for itself: a run is a set
       * of blocks, so a read fetches the block it needs and keeps it, rather
       * than dragging the whole run through memory every time.
       */
      const block = (name: string) =>
        Effect.gen(function* () {
          const kept = yield* Ref.get(cache);
          const known = kept.get(name);
          if (known !== undefined) {
            // Re-inserting is what keeps the map ordered least-recently-used.
            yield* Ref.update(cache, (one) => new Map(one).set(name, known));
            return known;
          }
          const found = yield* objects
            .get(name)
            .pipe(Effect.mapError((error) => asKvError(name, error)));
          if (Option.isNone(found)) {
            return yield* Effect.fail(
              new KvUnavailable({ message: `${name} vanished while reading` }),
            );
          }
          const decoded = decodeBlock(found.value.body);
          if (Option.isNone(decoded)) {
            return yield* Effect.fail(
              new KvUnavailable({ message: `${name} could not be read` }),
            );
          }
          const entries = decoded.value;
          yield* Ref.update(cache, (one) => {
            const grown = new Map(one).set(name, entries);
            for (const gone of [...grown.keys()].slice(
              0,
              Math.max(0, grown.size - cacheBlocks),
            )) {
              grown.delete(gone);
            }
            return grown;
          });
          return entries;
        });

      /** The blocks that could hold these keys, across every run. */
      const blocksFor = (keys: ReadonlyArray<Key>) =>
        Effect.gen(function* () {
          const known = yield* Ref.get(runs);
          return [
            ...new Set(
              known.flatMap((one) =>
                keys.flatMap((key) => Option.toArray(blockHolding(one, key))),
              ),
            ),
          ];
        });

      /** Every entry of every run — what a scan reads, because a scan is a scan. */
      const readAll = () =>
        Effect.gen(function* () {
          const known = yield* Ref.get(runs);
          const blocks = yield* Effect.forEach(
            known.flatMap(blocksOf),
            (name) => block(name),
          );
          return blocks.flat();
        });

      /** Only what could hold these keys — what a read reads. */
      const readFor = (keys: ReadonlyArray<Key>) =>
        Effect.gen(function* () {
          const names = yield* blocksFor(keys);
          const blocks = yield* Effect.forEach(names, (name) => block(name));
          return blocks.flat();
        });

      /** Write a run: its blocks, then the index that says what they hold. */
      const writeRun = (
        level: number,
        from: Sequence,
        to: Sequence,
        entries: ReadonlyArray<BlockEntry>,
      ) =>
        Effect.gen(function* () {
          const name = indexName(level, from, to);
          const blocks = toBlocks(name, entries);
          yield* Effect.forEach(blocks, (one) =>
            objects
              .put(one.name, encodeBlock(one.group))
              .pipe(Effect.mapError((error) => asKvError(one.name, error))),
          );
          const index: RunIndex = {
            level,
            from,
            to,
            blocks: blocks.map((one) => ({
              name: one.name,
              firstKey: one.firstKey,
              entries: one.entries,
            })),
          };
          // The index last: a run is not a run until its index says what it is.
          yield* objects
            .put(name, new TextEncoder().encode(encodeIndex(index)))
            .pipe(Effect.mapError((error) => asKvError(name, error)));
          return index;
        });

      /** Delete a run: its index, and every block it names. */
      const dropRun = (index: RunIndex) =>
        Effect.forEach(
          [indexName(index.level, index.from, index.to), ...blocksOf(index)],
          (gone) =>
            objects
              .delete(gone)
              .pipe(Effect.mapError((error) => asKvError(gone, error))),
        );

      /**
       * The memtable becomes a run of its own, at level 0.
       *
       * That is the whole of a flush now: it costs the tail and nothing else,
       * where folding the memtable into one big run cost the repo. Merging is
       * the next function's job, and it happens when a level has enough runs to
       * be worth merging.
       */
      const flush = (tail: Log, to: Sequence) =>
        Effect.gen(function* () {
          const from = (yield* Ref.get(flushed)) + 1;
          if (tail.size === 0 || to - from + 1 < threshold) {
            return;
          }
          const written = yield* writeRun(0, from, to, asBlockEntries(tail));
          yield* Ref.update(runs, (one) => [...one, written]);
          yield* Effect.forEach(
            Array.from({ length: to - from + 1 }, (_unused, at) =>
              logName(from + at),
            ),
            (gone) =>
              objects
                .delete(gone)
                .pipe(Effect.mapError((error) => asKvError(gone, error))),
          );
          yield* Ref.set(flushed, to);
          // The tail is in a run now, so the memtable starts empty.
          yield* Ref.set(state, new Map());
          yield* merge(0);
        });

      /**
       * Size-tiered compaction: when a level has `tier` runs, they become one
       * run at the next level.
       *
       * What a merge rewrites is the level it merges, not the live data — which
       * is the difference between a store that scales and one that stalls as the
       * repo grows. Eviction happens here, because this is the only place a
       * version is dropped.
       */
      // Recursive, so TypeScript cannot infer the return type (TS7023).
      // oxlint-disable-next-line diff-check/no-explicit-function-return-type
      const merge = (level: number): Effect.Effect<void, KvError> =>
        Effect.gen(function* () {
          const known = yield* Ref.get(runs);
          const at = known.filter((one) => one.level === level);
          if (at.length < tier) {
            return;
          }
          const merged = yield* Effect.forEach(at, (one) =>
            Effect.forEach(blocksOf(one), (name) => block(name)),
          );
          const oldest = yield* holds.watermark(yield* Ref.get(current));
          const kept = evict(
            mergeEntries(merged.flat().flat(), new Map()),
            oldest,
          );
          const written = yield* writeRun(
            level + 1,
            at.reduce(
              (lowest, one) => Math.min(lowest, one.from),
              at.at(0)?.from ?? 0,
            ),
            at.reduce((highest, one) => Math.max(highest, one.to), 0),
            asBlockEntries(kept),
          );
          yield* Effect.forEach(at, dropRun);
          yield* Ref.update(runs, (one) => [
            ...one.filter((each) => !at.includes(each)),
            written,
          ]);
          // The level above may have enough runs of its own now.
          yield* merge(level + 1);
        });

      const commit = (ops: ReadonlyArray<OpMap>) =>
        lock.withPermit(
          Effect.gen(function* () {
            const tail = yield* Ref.get(state);
            const at = yield* Ref.get(current);
            const entries = yield* readFor(ops.map((op) => op.key));

            const refused = ops.flatMap((op) => {
              const condition = op.condition;
              if (condition === undefined) {
                return [];
              }
              const view = new Map([
                [op.key, Option.toArray(resolveKey(tail, entries, op.key, at))],
              ]) as Log;
              return conditionHolds(view, op.key, condition)
                ? []
                : [
                    new KeyPreconditionFailed({
                      key: op.key,
                      expected: condition._tag,
                    }),
                  ];
            });
            const bad = refused.at(0);
            if (bad !== undefined) {
              return yield* Effect.fail(bad);
            }

            if (bounds !== undefined && held !== undefined) {
              yield* shardLease
                .fence(bounds.shard, held.epoch)
                .pipe(
                  Effect.mapError((error) => asLeaseError(bounds.shard, error)),
                );
            }
            yield* flush(tail, at);

            const version = at + 1;
            const name = logName(version);
            yield* objects
              .put(
                name,
                new TextEncoder().encode(
                  encodeLog({
                    writes: ops.map((op) => ({
                      key: op.key,
                      value: Match.value(op).pipe(
                        Match.tag('put', (write) => toBase64(write.value)),
                        Match.orElse(() => null),
                      ),
                    })),
                  }),
                ),
                ifAbsent(),
              )
              .pipe(Effect.mapError((error) => asKvError(name, error)));

            const appended = ops.reduce<Map<Key, Array<Versioned>>>(
              (acc, op) =>
                new Map(acc).set(op.key, [
                  ...(acc.get(op.key) ?? []),
                  {
                    version,
                    value: Match.value(op).pipe(
                      Match.tag('put', (write) => write.value),
                      Match.orElse(() => undefined),
                    ),
                  },
                ]),
              tail,
            );
            yield* Ref.set(state, appended);
            yield* Ref.set(current, version);
            return version;
          }),
        );

      const kv = Kv.of({
        sequence: Ref.get(current),

        get: (key, at) =>
          Effect.gen(function* () {
            const tail = yield* Ref.get(state);
            const now = yield* Ref.get(current);
            const moment = at ?? now;
            yield* within(moment, yield* holds.watermark(now));
            const found = resolveKey(tail, yield* readFor([key]), key, moment);
            return Option.map(found, (entry) => ({
              key,
              value: entry.value,
              version: entry.version,
            }));
          }),

        getMany: (keys, at) =>
          Effect.gen(function* () {
            const tail = yield* Ref.get(state);
            const now = yield* Ref.get(current);
            const moment = at ?? now;
            yield* within(moment, yield* holds.watermark(now));
            const entries = yield* readFor(keys);
            return keys.flatMap((key) =>
              Option.toArray(resolveKey(tail, entries, key, moment)).map(
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
            const tail = yield* Ref.get(state);
            const now = yield* Ref.get(current);
            const requested = options?.cursor;
            const decoded =
              requested === undefined
                ? Option.none<Cursor>()
                : decodeCursor(requested);
            if (requested !== undefined && Option.isNone(decoded)) {
              return yield* Effect.fail(
                new CursorInvalid({ cursor: requested }),
              );
            }

            const asked = options?.at;
            const at = Option.isSome(decoded)
              ? decoded.value.at
              : (asked ?? now);
            if (asked !== undefined && asked !== at) {
              return yield* Effect.fail(
                new CursorInvalid({ cursor: requested ?? '' }),
              );
            }
            yield* within(at, yield* holds.watermark(now));

            const entries = yield* readAll();
            const prefix = options?.prefix ?? '';
            const start = options?.start ?? prefix;
            const end = options?.end;
            const after = Option.isSome(decoded)
              ? decoded.value.key
              : undefined;
            const keys = [
              ...new Set([
                ...tail.keys(),
                ...entries.map((entry) => entry.key),
              ]),
            ]
              .filter(
                (key) =>
                  key.startsWith(prefix) &&
                  key >= start &&
                  (end === undefined || key < end) &&
                  (after === undefined || key > after),
              )
              .sort();

            const window = keys.slice(0, options?.limit ?? DEFAULT_LIMIT);
            const page = window.flatMap((key) =>
              Option.toArray(resolveKey(tail, entries, key, at)).map(
                (found) => ({
                  key,
                  value: found.value,
                  version: found.version,
                }),
              ),
            );
            const last = window.at(-1);
            const cursor =
              keys.length > window.length && last !== undefined
                ? encodeCursor({ at, key: last })
                : undefined;

            return cursor === undefined
              ? { at, entries: page }
              : { at, entries: page, cursor };
          }),

        snapshot: (at) =>
          Effect.gen(function* () {
            const now = yield* Ref.get(current);
            const wanted = at ?? now;
            // A hold below the watermark asks for history that is already gone.
            yield* within(wanted, yield* holds.watermark(now));
            return yield* holds.snapshot(wanted);
          }),
      });

      return {
        kv,
        stats: LsmStats.of({
          read: Effect.gen(function* () {
            const at = yield* Ref.get(current);
            const known = yield* Ref.get(runs);
            const cached = yield* Ref.get(cache);
            const levels = new Map<number, number>();
            for (const run of known) {
              levels.set(run.level, (levels.get(run.level) ?? 0) + 1);
            }
            return {
              sequence: at,
              runsByLevel: [...levels].map(([level, runs]) => ({
                level,
                runs,
              })),
              heldSnapshots: yield* holds.held,
              blockCacheEntries: cached.size,
            };
          }),
        }),
      };
    }),
  ).pipe(Layer.provide(holdsLayer));

/**
 * The LSM over the object store, providing the store **and** its own shape: two
 * views of one build, so the stats read the same refs the store writes.
 */
export const kvLsmLayer = (options: LsmOptions) => {
  const built = lsmFaces(options);
  return Layer.mergeAll(
    Layer.flatMap(built, (context) =>
      Layer.succeed(Kv, Context.get(context, Lsm).kv),
    ),
    Layer.flatMap(built, (context) =>
      Layer.succeed(LsmStats, Context.get(context, Lsm).stats),
    ),
  );
};
