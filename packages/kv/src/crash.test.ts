/**
 * The crash walk: the same workload, cut at **every** object write, then
 * reopened over the same bytes.
 *
 * The property an LSM lives or dies by: a batch the caller was told about is
 * still there after recovery, a batch is all there or none of it, and the
 * sequence never goes backwards. The fault sits at the object-store seam,
 * because that is where a bucket fails — a lost response, a process killed
 * between a run's index and the log objects that index replaces.
 *
 * Both halves of a lost response are walked. `before` is the write that never
 * happened; `after` is the write that landed and whose answer was lost — the
 * one that makes "it failed" not mean "it is not there".
 *
 * The store here is a Map with a kill switch and a small listing page, so
 * recovery's paging is walked too. Nothing about it is shipped: a simulated
 * disk is cheaper than a bucket and finds what a happy path cannot.
 */
import { Effect, Layer, Option } from 'effect';
import { type KvError, type OpMap, deleteOp, putOp } from './types.js';
import { LsmStats, kvLsmLayer } from './lsm.js';
import {
  type ObjectBody,
  type ObjectKey,
  ObjectStore,
  type ObjectStoreError,
  ObjectStoreUnavailable,
  PreconditionFailed,
  type StoredObject,
  type WriteConditionMap,
} from '@eoa/object-store';
import { describe, expect, it } from 'vitest';
import { Kv } from './kv.js';
import { createHash } from 'node:crypto';
import { shardLeaseLayer } from './lease.js';

/** A listing page small enough that recovery has to walk more than one. */
const PAGE = 3;

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const etagOf = (body: ObjectBody) =>
  createHash('sha256').update(body).digest('hex');

/** Whether a write condition holds for what is on the disk. */
const refused = (
  condition: WriteConditionMap | undefined,
  existing: ObjectBody | undefined,
) => {
  if (condition === undefined) {
    return false;
  }
  return condition._tag === 'absent'
    ? existing !== undefined
    : existing === undefined || etagOf(existing) !== condition.etag;
};

/**
 * The disk: the objects, and the point at which the process dies. `limit` is a
 * count of mutations, so every crash point is a number, and `mode` says whether
 * the fatal one lands before it is applied or after.
 */
interface Disk {
  readonly objects: Map<ObjectKey, ObjectBody>;
  mutations: number;
  limit: number;
  mode: 'before' | 'after';
  /** Once the process is gone, no further write happens. */
  dead: boolean;
  /** Serve bodies cut in half — a read that cannot be trusted. */
  torn: boolean;
}

const aDisk = (limit: number, mode: Disk['mode'] = 'before'): Disk => ({
  objects: new Map(),
  mutations: 0,
  limit,
  mode,
  dead: false,
  torn: false,
});

const gone = () =>
  new ObjectStoreUnavailable({ key: '', message: 'the process is gone' });

/** Apply a mutation, or die at it. */
const mutated = <A>(
  disk: Disk,
  apply: () => A,
): Effect.Effect<A, ObjectStoreError> =>
  Effect.suspend(() => {
    if (disk.dead) {
      return Effect.fail(gone());
    }
    if (disk.mutations >= disk.limit) {
      disk.dead = true;
      if (disk.mode === 'after') {
        // The write landed; the answer did not come back.
        disk.mutations += 1;
        apply();
      }
      return Effect.fail(gone());
    }
    disk.mutations += 1;
    return Effect.succeed(apply());
  });

/** The object store, over the disk: the seam a bucket fails at. */
const storeOf = (disk: Disk) =>
  Layer.succeed(
    ObjectStore,
    ObjectStore.of({
      get: (key) =>
        Effect.sync(() => {
          const body = disk.objects.get(key);
          if (body === undefined) {
            return Option.none<StoredObject>();
          }
          // The namespace the recovery reads is the one that gets cut: a torn
          // body must be refused, never read as a smaller store.
          const served =
            disk.torn && key.startsWith('log/')
              ? body.slice(0, Math.floor(body.length / 2))
              : body;
          return Option.some({ key, body: served, etag: etagOf(body) });
        }),
      put: (key, body, condition) =>
        Effect.suspend(() => {
          if (refused(condition, disk.objects.get(key))) {
            return Effect.fail(
              new PreconditionFailed({ key, expected: 'the write condition' }),
            );
          }
          return mutated(disk, () => {
            disk.objects.set(key, body);
            return etagOf(body);
          });
        }),
      delete: (key, condition) =>
        Effect.suspend(() => {
          if (refused(condition, disk.objects.get(key))) {
            return Effect.fail(
              new PreconditionFailed({ key, expected: 'the write condition' }),
            );
          }
          return mutated(disk, () => {
            disk.objects.delete(key);
          });
        }),
      list: (options) =>
        Effect.sync(() => {
          const prefix = options?.prefix ?? '';
          const after = options?.cursor;
          const limit = options?.limit ?? PAGE;
          const keys = [...disk.objects.keys()]
            .filter(
              (key) =>
                key.startsWith(prefix) && (after === undefined || key > after),
            )
            .sort();
          const page = keys.slice(0, limit);
          const last = page.at(-1);
          return keys.length > page.length && last !== undefined
            ? { keys: page, cursor: last }
            : { keys: page };
        }),
    }),
  );

const layersOf = (disk: Disk) => {
  const store = storeOf(disk);
  // Unleased on purpose: the walk is about the log and the runs, and taking a
  // lease is one `ifAbsent` put that would only be one more crash point.
  return kvLsmLayer({ threshold: 3, tier: 2 }).pipe(
    Layer.provide([shardLeaseLayer.pipe(Layer.provide(store)), store]),
  );
};

const onDisk = <A, E>(disk: Disk, effect: Effect.Effect<A, E, Kv | LsmStats>) =>
  Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(layersOf(disk))));

/** One batch in the walk: a value writes the key, `null` deletes it. */
type Write = Readonly<{ key: string; value: string | null }>;

/**
 * Twelve batches over five keys, so the walk crosses two flushes and a merge,
 * with a delete and an overwrite in the middle of each.
 */
const batches: ReadonlyArray<ReadonlyArray<Write>> = [
  [
    { key: 'a', value: 'a1' },
    { key: 'b', value: 'b1' },
  ],
  [
    { key: 'a', value: 'a2' },
    { key: 'c', value: 'c1' },
  ],
  [{ key: 'b', value: 'b2' }],
  [
    { key: 'd', value: 'd1' },
    { key: 'c', value: 'c2' },
  ],
  [{ key: 'b', value: null }],
  [{ key: 'a', value: 'a3' }],
  [
    { key: 'e', value: 'e1' },
    { key: 'd', value: 'd2' },
  ],
  [
    { key: 'c', value: 'c3' },
    { key: 'e', value: null },
  ],
  [
    { key: 'b', value: 'b3' },
    { key: 'd', value: 'd3' },
  ],
  [{ key: 'a', value: null }],
  [
    { key: 'c', value: 'c4' },
    { key: 'e', value: 'e2' },
  ],
  [
    { key: 'b', value: 'b4' },
    { key: 'a', value: 'a4' },
  ],
];

const KEYS = ['a', 'b', 'c', 'd', 'e'] as const;

const opsOf = (batch: ReadonlyArray<Write>): ReadonlyArray<OpMap> =>
  batch.map(({ key, value }) =>
    value === null ? deleteOp({ key }) : putOp({ key, value: bytes(value) }),
  );

/** What the store must hold after the first `upto` batches, exactly. */
const expected = (upto: number) =>
  batches.slice(0, upto).reduce((state, batch) => {
    const next = new Map(state);
    for (const { key, value } of batch) {
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    return next;
  }, new Map<string, string>());

/** Batch the walk, and report how many the caller was told about. */
const replay = (walk: ReadonlyArray<ReadonlyArray<Write>>) =>
  Effect.gen(function* () {
    const kv = yield* Kv;
    let acknowledged = 0;
    for (const batch of walk) {
      const landed = yield* kv.batch(opsOf(batch)).pipe(
        Effect.map(() => true),
        // A dead process refuses everything, including the batch it was on.
        Effect.orElseSucceed(() => false),
      );
      if (!landed) {
        break;
      }
      acknowledged += 1;
    }
    return acknowledged;
  });

/** Read back what a fresh process over the same disk sees. */
const recovered = (disk: Disk) =>
  onDisk(
    disk,
    Effect.gen(function* () {
      const kv = yield* Kv;
      const stats = yield* LsmStats;
      const at = yield* kv.sequence;
      const entries = yield* kv.getMany([...KEYS]);
      const { runsByLevel } = yield* stats.read;
      return {
        at,
        runs: runsByLevel.reduce((all, level) => all + level.runs, 0),
        state: new Map(entries.map((entry) => [entry.key, text(entry.value)])),
      };
    }),
  );

const sameState = (
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
) =>
  left.size === right.size &&
  [...left].every(([key, value]) => right.get(key) === value);

/** Reopen the same bytes with nothing left to kill. */
const reopen = (disk: Disk): Disk => {
  disk.limit = Number.POSITIVE_INFINITY;
  disk.dead = false;
  return disk;
};

describe('the LSM, killed at every object write', () => {
  it('keeps what it acknowledged, lands batches whole, and never rewinds', async () => {
    const clean = aDisk(Number.POSITIVE_INFINITY);
    const all = await onDisk(clean, replay(batches));
    expect(all).toBe(batches.length);
    // The workload has to be big enough to flush and merge, or this proves
    // nothing about the interesting half of the store.
    expect(clean.mutations).toBeGreaterThan(batches.length * 2);
    const total = clean.mutations;
    let withRuns = 0;
    let withoutRuns = 0;
    let ahead = 0;

    for (const mode of ['before', 'after'] as const) {
      // `total` is one past the last mutation: killing after all of them is not
      // a crash point, it is just the clean run.
      for (let limit = 0; limit < total; limit += 1) {
        const disk = aDisk(limit, mode);
        const acknowledged = await onDisk(disk, replay(batches));
        expect(disk.dead, `limit ${limit} (${mode}) never crashed`).toBe(true);

        const seen = await recovered(reopen(disk));
        // A write that landed with its answer lost may be one batch ahead;
        // nothing else may be true.
        const possible =
          mode === 'before' ? [acknowledged] : [acknowledged, acknowledged + 1];
        expect(
          possible,
          `limit ${limit} (${mode}): recovered at ${seen.at}`,
        ).toContain(seen.at);
        expect(
          sameState(expected(seen.at), seen.state),
          `limit ${limit} (${mode}): the state at ${seen.at} is not the state after ${seen.at} batches — a batch was torn`,
        ).toBe(true);

        // Coverage, so a green run cannot mean the walk missed the store's
        // interesting half.
        if (seen.runs > 0) {
          withRuns += 1;
        } else {
          withoutRuns += 1;
        }
        if (seen.at > acknowledged) {
          ahead += 1;
        }
      }
    }

    expect(withRuns, 'no crash point left a run on disk').toBeGreaterThan(0);
    expect(withoutRuns, 'no crash point left only the log').toBeGreaterThan(0);
    expect(ahead, 'no lost answer kept the batch it killed').toBeGreaterThan(0);
  });

  it('refuses to recover from a body it cannot read, instead of dropping it', async () => {
    const disk = aDisk(Number.POSITIVE_INFINITY);
    await onDisk(disk, replay(batches.slice(0, 2)));
    disk.torn = true;

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const kv = yield* Kv;
        return yield* kv.get('a');
      }).pipe(
        Effect.provide(layersOf(disk)),
        Effect.map(() => 'read'),
        Effect.catch((error: KvError) => Effect.succeed(error._tag)),
      ),
    );

    expect(outcome).toBe('KvUnavailable');
  });
});
