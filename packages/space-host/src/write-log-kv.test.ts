import { ALICE, NOTES, SPACE, cid, nsid, rkey, tid } from './fixtures.js';
import {
  BadRecordSwapError,
  SpaceWriteLog,
  StaleEpochError,
  headOf,
  spaceWriteLogKvLayer,
  writeLockOverLease,
} from './write-log.js';
import { Effect, Layer, Result } from 'effect';
import {
  Kv,
  ShardLease,
  type ShardLeaseShape,
  kvMemoryLayer,
  makeShardLease,
} from '@eoa/kv';
import { ObjectStore, filesystemObjectStoreLayer } from '@eoa/object-store';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The durable log over a real `Kv` (memory) and a real `ShardLease` (the
 * filesystem object store, the adapter `packages/kv/src/lease.test.ts` uses).
 * Nothing is faked: the CAS is the KV's conditional write and the fence is the
 * lease's stored epoch, so both refusals come from the store, not from memory.
 */

interface Store {
  readonly kv: Kv['Service'];
  readonly objects: ObjectStore['Service'];
  readonly lease: ShardLeaseShape;
}

const openStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'space-write-log-'));
  const opened = await Effect.runPromise(
    Effect.gen(function* () {
      return { kv: yield* Kv, objects: yield* ObjectStore };
    }).pipe(
      Effect.provide(
        Layer.merge(kvMemoryLayer, filesystemObjectStoreLayer(directory)),
      ),
    ),
  );
  return {
    store: { ...opened, lease: makeShardLease(opened.objects) },
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

/**
 * Run `program` against ONE instance of the log layer over `store`. Calling
 * this twice is two host processes: nothing but the `Kv` and the lease objects
 * are shared.
 */
/** The log with its fence resolved: what a host process would hold. */
const fencedLog = spaceWriteLogKvLayer.pipe(
  Layer.provide(writeLockOverLease('test-host')),
);

const runLog = <A, E>(
  store: Store,
  program: Effect.Effect<A, E, SpaceWriteLog | ShardLease>,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        fencedLog.pipe(
          Layer.provideMerge(
            Layer.merge(
              Layer.succeed(Kv, store.kv),
              Layer.succeed(ShardLease, store.lease),
            ),
          ),
        ),
      ),
      Effect.orDie,
    ),
  );

const withStore = async <A>(body: (store: Store) => Promise<A>) => {
  const opened = await openStore();
  try {
    return await body(opened.store);
  } finally {
    await opened.close();
  }
};

const op = (fields: {
  readonly cid: string;
  readonly rkey?: string;
  readonly collection?: string;
}) => ({
  space: SPACE,
  collection: nsid(fields.collection ?? NOTES),
  rkey: rkey(fields.rkey ?? 'r1'),
  action: 'create' as const,
  rev: tid('aaaaaaaaaaaaa'),
  author: ALICE,
  signature: new Uint8Array([1, 2, 3]),
  cid: cid(fields.cid),
});

const REPO = { space: SPACE, did: ALICE };

const clearOp = {
  space: SPACE,
  action: 'clear' as const,
  rev: tid('aaaaaaaaaaaab'),
  author: ALICE,
  signature: new Uint8Array([4]),
  data: new Uint8Array([0]),
};

describe('the durable write log over Kv', () => {
  it('two appends on the same observed head: one wins, the other loses the swap', async () => {
    const result = await withStore((store) =>
      runLog(
        store,
        Effect.gen(function* () {
          const log = yield* SpaceWriteLog;
          const epoch = (yield* (yield* ShardLease).acquire(SPACE, 'host-a'))
            .epoch;
          const base = yield* log.head(REPO);
          const outcomes = yield* Effect.all(
            [
              log.append(REPO, op({ rkey: 'a', cid: 'bafya' }), {
                base,
                epoch,
              }),
              log.append(REPO, op({ rkey: 'b', cid: 'bafyb' }), {
                base,
                epoch,
              }),
            ],
            { concurrency: 'unbounded', mode: 'result' },
          );
          return {
            outcomes,
            entries: yield* log.entries(REPO),
            head: yield* log.head(REPO),
          };
        }),
      ),
    );

    expect(result.outcomes.filter(Result.isSuccess)).toHaveLength(1);
    const lost = result.outcomes.find(Result.isFailure);
    expect(lost === undefined ? undefined : lost.failure).toBeInstanceOf(
      BadRecordSwapError,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.head).toBe(headOf(result.entries));
  });

  it('a superseded epoch is refused even though the head still matches', async () => {
    const result = await withStore((store) =>
      runLog(
        store,
        Effect.gen(function* () {
          const log = yield* SpaceWriteLog;
          const lease = yield* ShardLease;
          const first = yield* lease.acquire(SPACE, 'host-a');
          const second = yield* lease.acquire(SPACE, 'host-b');
          yield* log.append(REPO, op({ cid: 'bafyfirst' }), {
            base: null,
            epoch: second.epoch,
          });
          const before = yield* log.entries(REPO);
          // `base` is the CURRENT head: the in-memory check alone would commit.
          const fenceError = yield* log
            .append(REPO, op({ rkey: 'r2', cid: 'bafylate' }), {
              base: cid('bafyfirst'),
              epoch: first.epoch,
            })
            .pipe(Effect.flip);
          return {
            first,
            second,
            fenceError,
            before,
            after: yield* log.entries(REPO),
            head: yield* log.head(REPO),
          };
        }),
      ),
    );

    expect(result.fenceError).toBeInstanceOf(StaleEpochError);
    expect(result.fenceError).toMatchObject({
      presented: result.first.epoch,
      current: result.second.epoch,
    });
    expect(result.after).toEqual(result.before);
    expect(result.after).toHaveLength(1);
    expect(result.head).toBe('bafyfirst');
  });

  it('a fresh layer over the same Kv reads the whole log and the same head', async () => {
    const result = await withStore(async (store) => {
      const first = await runLog(
        store,
        Effect.gen(function* () {
          const log = yield* SpaceWriteLog;
          const current = (yield* (yield* ShardLease).acquire(SPACE, 'host-a'))
            .epoch;
          yield* log.append(REPO, op({ cid: 'bafy1' }), {
            base: null,
            epoch: current,
          });
          yield* log.append(REPO, op({ rkey: 'r2', cid: 'bafy2' }), {
            base: cid('bafy1'),
            epoch: current,
          });
          return { head: yield* log.head(REPO) };
        }),
      );
      // A second instance, same store, no in-process memory carried over.
      const second = await runLog(
        store,
        Effect.gen(function* () {
          const log = yield* SpaceWriteLog;
          return {
            entries: yield* log.entries(REPO),
            head: yield* log.head(REPO),
            state: yield* log.state(REPO),
          };
        }),
      );
      return { first, second };
    });

    expect(result.first.head).toBe('bafy2');
    expect(
      result.second.entries.map((one) =>
        one.action === 'clear' ? 'clear' : one.cid,
      ),
    ).toEqual(['bafy1', 'bafy2']);
    expect(result.second.head).toBe('bafy2');
    expect([...result.second.state.keys()]).toEqual([
      `${NOTES}/r1`,
      `${NOTES}/r2`,
    ]);
  });

  it('clear: refused under a superseded epoch, one entry under the current one, then creates from null', async () => {
    const result = await withStore((store) =>
      runLog(
        store,
        Effect.gen(function* () {
          const log = yield* SpaceWriteLog;
          const lease = yield* ShardLease;
          const first = yield* lease.acquire(SPACE, 'host-a');
          const second = yield* lease.acquire(SPACE, 'host-b');
          yield* log.append(REPO, op({ cid: 'bafy1' }), {
            base: null,
            epoch: second.epoch,
          });
          const stale = yield* log
            .clear(REPO, clearOp, { base: cid('bafy1'), epoch: first.epoch })
            .pipe(Effect.flip);
          const beforeClear = yield* log.entries(REPO);
          const position = yield* log.clear(REPO, clearOp, {
            base: cid('bafy1'),
            epoch: second.epoch,
          });
          const afterClear = yield* log.entries(REPO);
          const clearedHead = yield* log.head(REPO);
          const created = yield* log.append(REPO, op({ cid: 'bafy2' }), {
            base: clearedHead,
            epoch: second.epoch,
          });
          return {
            stale,
            beforeClear,
            position,
            afterClear,
            clearedHead,
            created,
            head: yield* log.head(REPO),
          };
        }),
      ),
    );

    expect(result.stale).toBeInstanceOf(StaleEpochError);
    expect(result.beforeClear).toHaveLength(1);
    expect(result.position).toBe(2);
    expect(result.afterClear).toHaveLength(2);
    expect(result.afterClear.at(-1)?.action).toBe('clear');
    // `headOf` after a clear is null, and so is the head the store reports.
    expect(headOf(result.afterClear)).toBeNull();
    expect(result.clearedHead).toBeNull();
    // The next write is a create from null even for a record that existed before.
    expect(result.created).toBe(3);
    expect(result.head).toBe('bafy2');
  });
});
