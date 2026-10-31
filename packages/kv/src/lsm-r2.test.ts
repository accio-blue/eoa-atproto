import { Effect, Layer, Option } from 'effect';
import {
  ObjectStore,
  type R2BucketLike,
  r2ObjectStoreLayer,
} from '@eoa/object-store';
import { ShardLease, shardLeaseLayer } from './lease.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kv } from './kv.js';
import { Miniflare } from 'miniflare';
import { kvLsmLayer } from './lsm.js';

const bytes = (value: string) => new TextEncoder().encode(value);

const read = (found: Option.Option<{ readonly value: Uint8Array }>) =>
  Option.isSome(found)
    ? new TextDecoder().decode(found.value.value)
    : undefined;

/**
 * The vlpds engine as a Worker runs it: `@eoa/kv`'s LSM and its lease, on an R2 binding. Miniflare
 * is Cloudflare's own local R2, so the conditional writes the sequence claim and the fencing rest
 * on are the runtime's, not a fixture's.
 */
let miniflare: Miniflare;
beforeAll(() => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response() }',
    r2Buckets: ['BUCKET'],
  });
});
afterAll(async () => {
  await miniflare.dispose();
});

const freshBucket = async () => {
  const bucket = (await miniflare.getR2Bucket(
    'BUCKET',
  )) as unknown as R2BucketLike;
  for (const one of (await bucket.list()).objects) {
    await bucket.delete(one.key);
  }
  return r2ObjectStoreLayer(bucket);
};

const engine = (
  store: Layer.Layer<ObjectStore>,
  options: Parameters<typeof kvLsmLayer>[0],
) =>
  kvLsmLayer(options).pipe(
    Layer.provide([shardLeaseLayer.pipe(Layer.provide(store)), store]),
  );

describe('the vlpds engine: the LSM on an R2 binding', () => {
  it('round-trips through compaction and survives a restart', async () => {
    const store = await freshBucket();
    await Effect.runPromise(
      Effect.gen(function* () {
        const kv = yield* Kv;
        for (const key of ['a', 'b', 'c', 'd', 'e']) {
          yield* kv.put(key, bytes(key));
        }
      }).pipe(Effect.orDie, Effect.provide(engine(store, { threshold: 2 }))),
    );
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const kv = yield* Kv;
        return {
          a: read(yield* kv.get('a')),
          e: read(yield* kv.get('e')),
          sequence: yield* kv.sequence,
        };
      }).pipe(Effect.orDie, Effect.provide(engine(store, { threshold: 2 }))),
    );

    expect(after).toEqual({ a: 'a', e: 'e', sequence: 5 });
  });

  it('fences a writer whose shard another owner has taken', async () => {
    const store = await freshBucket();
    const write = (key: string) =>
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put(key, bytes(key));
      });
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* Layer.build(
            engine(store, { threshold: 8, lease: { shard: 's', owner: 'a' } }),
          );
          yield* Effect.provide(write('a'), live);
          yield* Effect.provide(
            Effect.gen(function* () {
              const lease = yield* ShardLease;
              yield* lease.acquire('s', 'b');
            }),
            shardLeaseLayer.pipe(Layer.provide(store)),
          );
          return yield* Effect.provide(Effect.flip(write('b')), live);
        }),
      ).pipe(Effect.orDie),
    );

    expect(failure._tag).toBe('KeyPreconditionFailed');
  });
});
