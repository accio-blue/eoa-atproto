import { Effect, Layer, Option } from 'effect';
import { ShardLease, shardLeaseLayer } from './lease.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { filesystemObjectStoreLayer } from '@eoa/object-store';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = <A, E>(
  directory: string,
  effect: Effect.Effect<A, E, ShardLease>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.orDie,
      Effect.provide(
        shardLeaseLayer.pipe(
          Layer.provide(filesystemObjectStoreLayer(directory)),
        ),
      ),
    ),
  );

const withDirectory = async <A>(body: (directory: string) => Promise<A>) => {
  const directory = await mkdtemp(join(tmpdir(), 'kv-lease-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('the shard lease', () => {
  it('claims an unowned shard, idempotently for its owner', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        Effect.gen(function* () {
          const lease = yield* ShardLease;
          return {
            first: yield* lease.acquire('s', 'a'),
            again: yield* lease.acquire('s', 'a'),
          };
        }),
      ),
    );

    expect(result.first).toEqual({ owner: 'a', epoch: 1 });
    expect(result.again).toEqual({ owner: 'a', epoch: 1 });
  });

  it('reads nothing for a shard nobody holds', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        Effect.gen(function* () {
          const lease = yield* ShardLease;
          return yield* lease.read('free');
        }),
      ),
    );

    expect(Option.isNone(result)).toBe(true);
  });

  it('takes over by bumping the epoch, and fences the owner it replaced', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        Effect.gen(function* () {
          const lease = yield* ShardLease;
          const first = yield* lease.acquire('s', 'a');
          const second = yield* lease.acquire('s', 'b');
          const fenced = yield* Effect.flip(lease.fence('s', first.epoch));
          const current = yield* lease.fence('s', second.epoch);
          return { first, second, fenced, current };
        }),
      ),
    );

    expect(result.first).toEqual({ owner: 'a', epoch: 1 });
    expect(result.second).toEqual({ owner: 'b', epoch: 2 });
    expect(result.fenced._tag).toBe('LeaseLost');
    expect(result.current).toBeUndefined();
  });

  it('serialises two writers racing for an unowned shard', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        Effect.gen(function* () {
          const lease = yield* ShardLease;
          const raced = yield* Effect.all(
            [lease.acquire('s', 'a'), lease.acquire('s', 'b')],
            { concurrency: 'unbounded' },
          );
          const now = yield* lease.read('s');
          return { epochs: raced.map((held) => held.epoch).sort(), now };
        }),
      ),
    );

    expect(result.epochs).toEqual([1, 2]);
    expect(Option.isSome(result.now) ? result.now.value.epoch : undefined).toBe(
      2,
    );
  });

  it('survives a restart', async () => {
    const result = await withDirectory(async (directory) => {
      await run(
        directory,
        Effect.gen(function* () {
          const lease = yield* ShardLease;
          yield* lease.acquire('s', 'a');
        }),
      );
      return await run(
        directory,
        Effect.gen(function* () {
          const lease = yield* ShardLease;
          return yield* lease.read('s');
        }),
      );
    });

    expect(result).toEqual(Option.some({ owner: 'a', epoch: 1 }));
  });
});
