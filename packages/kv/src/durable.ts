import {
  DEFAULT_LIMIT,
  EMPTY,
  Holds,
  type Log,
  type Versioned,
  commitTo,
  decodeCursor,
  entriesAt,
  evict,
  holdsLayer,
  scanState,
  valueAt,
} from './engine.js';
import { Effect, Layer, Match, Option } from 'effect';
import {
  type Key,
  KvUnavailable,
  type OpMap,
  type ScanOptions,
  type Sequence,
  SnapshotExpired,
  deleteOp,
  putOp,
} from './types.js';
import { Kv } from './kv.js';

/**
 * The durable backend, for a runtime that hands you a durable key-value store and **one
 * writer at a time** — a Durable Object's `state.storage`.
 *
 * It is `memory.ts` with the `Ref` replaced, and that is the whole implementation: the
 * sequenced semantics live in `engine.ts` as pure functions over a `State`, so a backend
 * persists a state and reuses the meaning. Nothing here decides what a version is.
 *
 * ## Why one writer is the right shape
 *
 * The contract's `Sequence` is a clock that must not go backwards, and `put`'s conditions are
 * compare-and-set. A store with concurrent writers needs a transaction to keep those honest; a
 * Durable Object runs one thing at a time and gates storage access, so read-compute-write *is*
 * the transaction. The awkward part of this interface is free here.
 *
 * ## Why a row per key
 *
 * A Durable Object caps a value at **128 KiB**, and this backend has twice been bounded by that
 * cap rather than by what it holds: once when the whole store was one value, which made
 * `pds.lexicon.ing` refuse every write while serving reads (bean `tie8`), and once when the log
 * was one row per *bucket* of keys, which moved the ceiling from the store to a collection but
 * left every record's bytes inside it (bean `xblb`).
 *
 * So the row *is* the key. `kv.k/{key}` holds that key's versions, `kv.head` holds the sequence,
 * and nothing else is stored — which is the shape where a cap can only ever bite one record, never
 * a collection, never a repository, and never the store. A point read is one row; a scan walks the
 * rows in key order and reads only the page it is about to hand out.
 *
 * ## The one ceiling left, named
 *
 * A *record* must still fit under 128 KiB, because a record is a value. That is the platform's own
 * limit and it is the right one to meet: what it refuses is a single object, not the store.
 */
export interface DurableStorage {
  readonly get: <A>(key: string) => Promise<A | undefined>;
  readonly getMany: <A>(
    keys: ReadonlyArray<string>,
  ) => Promise<ReadonlyMap<string, A>>;
  readonly put: <A>(key: string, value: A) => Promise<void>;
  /**
   * The stored keys from `start` on, under a prefix: how a scan finds its rows.
   *
   * `start` is inclusive, and a caller that has already seen a row passes it as `start` and skips it
   * itself — which is all a resumable scan needs from a store.
   */
  readonly list: (options?: {
    readonly prefix?: string;
    readonly start?: string;
    readonly limit?: number;
  }) => Promise<ReadonlyArray<string>>;
}

/** How many rows one step of a scan reads. */
const CHUNK = 64;

/** The sequence, and which layout the store is in. */
const HEAD_KEY = 'kv.head';

/** One row per key, holding that key's versions. */
const ROW_PREFIX = 'kv.k/';

/**
 * Where a store that predates the rows kept things: the whole `State` in one value, and the buckets
 * that replaced it. Read once each, and **left where they are** — nothing here deletes them, so the
 * value a deployment was running on is still there if a migration is ever in doubt.
 */
const LEGACY_STATE_KEY = 'kv.state';
const LEGACY_BUCKETS = 'kv.log/';

const rowOf = (key: Key) => `${ROW_PREFIX}${key}`;
const keyOfRow = (row: string) => row.slice(ROW_PREFIX.length);

interface Head {
  readonly sequence: Sequence;
  /** Absent on a store from before the rows, which is exactly what says to migrate it. */
  readonly layout?: 'rows';
}

const readRow = <A>(
  storage: DurableStorage,
  key: string,
): Effect.Effect<A | undefined, KvUnavailable> =>
  Effect.tryPromise({
    try: () => storage.get<A>(key),
    catch: (cause) => new KvUnavailable({ message: String(cause) }),
  });

const writeRow = <A>(
  storage: DurableStorage,
  key: string,
  value: A,
): Effect.Effect<void, KvUnavailable> =>
  Effect.tryPromise({
    try: () => storage.put(key, value),
    catch: (cause) => new KvUnavailable({ message: String(cause) }),
  });

const listRows = (
  storage: DurableStorage,
  options: {
    readonly prefix: string;
    readonly start?: string;
    readonly limit?: number;
  },
): Effect.Effect<ReadonlyArray<string>, KvUnavailable> =>
  Effect.tryPromise({
    try: () => storage.list(options),
    catch: (cause) => new KvUnavailable({ message: String(cause) }),
  });

/** The versions of these keys, in one read: a row each, and a bulk get. */
const readKeys = (
  storage: DurableStorage,
  keys: ReadonlyArray<Key>,
): Effect.Effect<Log, KvUnavailable> =>
  Effect.gen(function* () {
    if (keys.length === 0) {
      return EMPTY.log;
    }
    const rows = yield* Effect.tryPromise({
      try: () => storage.getMany<ReadonlyArray<Versioned>>(keys.map(rowOf)),
      catch: (cause) => new KvUnavailable({ message: String(cause) }),
    });
    return new Map(
      keys.flatMap((key) => {
        const found = rows.get(rowOf(key));
        return found === undefined ? [] : [[key, found] as const];
      }),
    );
  });

/**
 * Bring a store that predates the rows into the shape this backend reads.
 *
 * The sources are the two shapes there have been. Read in order, so the *newer* wins per key: the
 * buckets were written from the whole state and then carried every write since, so their version
 * arrays are the longer ones. The head is written **last**, so a store that died mid-migration is
 * migrated again rather than half-read, and its sequence is taken from the head rather than from a
 * state that stopped being written to.
 *
 * Idempotent — the head's layout is what says it is done — and called from the Durable Object's
 * constructor inside `blockConcurrencyWhile`: a request that committed rows while the migration was
 * still writing would have them overwritten by it.
 */
const migrate = (storage: DurableStorage): Effect.Effect<Head, KvUnavailable> =>
  Effect.gen(function* () {
    const head = yield* readRow<Head>(storage, HEAD_KEY);
    if (head !== undefined && head.layout === 'rows') {
      return head;
    }

    const whole = yield* readRow<{ sequence: Sequence; log: Log }>(
      storage,
      LEGACY_STATE_KEY,
    );
    const buckets = yield* listRows(storage, { prefix: LEGACY_BUCKETS });
    const held = yield* Effect.forEach(
      buckets,
      (row) => readRow<Log>(storage, row),
      { concurrency: 4 },
    );

    const log = new Map<Key, ReadonlyArray<Versioned>>();
    for (const one of [whole?.log, ...held]) {
      for (const [key, versions] of one ?? []) {
        log.set(key, versions);
      }
    }

    yield* Effect.forEach(
      [...log],
      ([key, versions]) => writeRow(storage, rowOf(key), versions),
      { concurrency: 8 },
    );
    const migrated: Head = {
      sequence: head?.sequence ?? whole?.sequence ?? 0,
      layout: 'rows',
    };
    yield* writeRow(storage, HEAD_KEY, migrated);
    return migrated;
  });

/**
 * The migration, for a runtime that can run it before any request arrives.
 *
 * A Durable Object can (`blockConcurrencyWhile`); a test can call it to set a store up. It is the
 * same function the reads fall back to, so there is one definition of what the shape is.
 *
 * **A failure here must not be fatal.** A constructor whose `blockConcurrencyWhile` promise rejects
 * takes the whole object with it: every request afterwards answers with the platform's own page
 * (`error code: 1101`) and says nothing about why -- which is exactly how this was found, hours after
 * a migration that had worked. So the failure is named and left to the reads, where the same function
 * runs again and a failure is one request's answer instead of every request's.
 */
export const migrateStore = (storage: DurableStorage): Promise<void> =>
  Effect.runPromise(
    migrate(storage).pipe(
      Effect.catch((problem) =>
        Effect.logWarning(
          `the store could not be migrated before the first request: ${problem.message}`,
        ),
      ),
    ),
  ).then(() => undefined);

export const kvDurableLayer = (
  storage: DurableStorage,
): Layer.Layer<Kv, never> =>
  Layer.effect(
    Kv,
    Effect.gen(function* () {
      const holds = yield* Holds;

      const within = (moment: Sequence, oldest: Sequence) =>
        moment < oldest
          ? Effect.fail(new SnapshotExpired({ at: moment, oldest }))
          : Effect.void;

      const commit = (ops: ReadonlyArray<OpMap>) =>
        Effect.gen(function* () {
          const current = yield* migrate(storage);
          const touched = [...new Set(ops.map((op) => op.key))];
          const log = yield* readKeys(storage, touched);
          const result = commitTo({ sequence: current.sequence, log }, ops);
          return yield* Match.value(result).pipe(
            Match.tagsExhaustive({
              committed: (done) =>
                Effect.gen(function* () {
                  const oldest = yield* holds.watermark(done.state.sequence);
                  const kept = evict(done.state.log, oldest);
                  // **The rows first, then the head.** A crash between the two leaves versions the
                  // head does not claim yet: unreadable (a version above the sequence is not visible)
                  // and overwritten by a retry, which computes the same version. The other order
                  // would lose a write the head had already promised.
                  yield* Effect.forEach(
                    touched,
                    (key) => writeRow(storage, rowOf(key), kept.get(key) ?? []),
                    { concurrency: 4 },
                  );
                  yield* writeRow(storage, HEAD_KEY, {
                    sequence: done.state.sequence,
                    layout: 'rows',
                  } satisfies Head);
                  return done.state.sequence;
                }),
              // A rejection writes nothing at all, which is what "atomic" means for a batch
              // whose precondition failed.
              rejected: (bad) => Effect.fail(bad.error),
            }),
          );
        });

      return Kv.of({
        sequence: migrate(storage).pipe(Effect.map((one) => one.sequence)),

        get: (key, at) =>
          Effect.gen(function* () {
            const current = yield* migrate(storage);
            const log = yield* readKeys(storage, [key]);
            const moment = at ?? current.sequence;
            yield* within(moment, yield* holds.watermark(current.sequence));
            return Option.map(valueAt(log, key, moment), (found) => ({
              key,
              value: found.value,
              version: found.version,
            }));
          }),

        getMany: (keys, at) =>
          Effect.gen(function* () {
            const current = yield* migrate(storage);
            const log = yield* readKeys(storage, keys);
            const moment = at ?? current.sequence;
            yield* within(moment, yield* holds.watermark(current.sequence));
            return keys.flatMap((key) =>
              Option.toArray(valueAt(log, key, moment)).map((found) => ({
                key,
                value: found.value,
                version: found.version,
              })),
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
            const current = yield* migrate(storage);
            const prefix = `${ROW_PREFIX}${options?.prefix ?? ''}`;
            const limit = options?.limit ?? DEFAULT_LIMIT;
            const requested = options?.cursor;
            const decoded =
              requested === undefined ? Option.none() : decodeCursor(requested);
            if (requested !== undefined && Option.isNone(decoded)) {
              // The shape of the refusal is `scanState`'s business; nothing needs reading for it.
              return yield* scanState(
                { sequence: current.sequence, log: EMPTY.log },
                options,
              );
            }

            const at = Option.isSome(decoded)
              ? decoded.value.at
              : (options?.at ?? current.sequence);

            // A page is read, not implied: rows are one per key, and a deleted key's row is not an
            // entry. Walk them in key order and stop as soon as there is certainly more than a page.
            let from: string | undefined = Option.isSome(decoded)
              ? rowOf(decoded.value.key)
              : options?.start === undefined
                ? undefined
                : rowOf(options.start);
            let seen = Option.isSome(decoded);
            const log = new Map<Key, ReadonlyArray<Versioned>>();
            while (entriesAt(log, at).length <= limit) {
              const rows = yield* listRows(storage, {
                prefix,
                start: from ?? prefix,
                limit: CHUNK,
              });
              const fresh = rows.filter(
                (row) =>
                  from === undefined || (seen ? row > from : row >= from),
              );
              const last = fresh.at(-1);
              if (last === undefined) {
                break;
              }
              from = last;
              seen = true;
              const found = yield* readKeys(storage, fresh.map(keyOfRow));
              for (const [key, versions] of found) {
                log.set(key, versions);
              }
            }

            const page = yield* scanState(
              { sequence: current.sequence, log },
              options,
            );
            yield* within(page.at, yield* holds.watermark(current.sequence));
            return page;
          }),

        snapshot: (at) =>
          Effect.gen(function* () {
            const current = yield* migrate(storage);
            const wanted = at ?? current.sequence;
            yield* within(wanted, yield* holds.watermark(current.sequence));
            return yield* holds.snapshot(wanted);
          }),
      });
    }),
  ).pipe(Layer.provide(holdsLayer));
