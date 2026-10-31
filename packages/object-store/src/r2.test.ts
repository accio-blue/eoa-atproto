import { Effect, Option } from 'effect';
import { type R2BucketLike, r2ObjectStoreLayer } from './r2.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ifAbsent, ifHolds } from './types.js';
import { Miniflare } from 'miniflare';
import { ObjectStore } from './object-store.js';

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

// Cloudflare's own local R2, not a fake of it: the conditional semantics are the runtime's.
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

/** The bucket, emptied, for each test. */
const withStore = async <A, E>(body: Effect.Effect<A, E, ObjectStore>) => {
  const bucket = (await miniflare.getR2Bucket(
    `BUCKET`,
  )) as unknown as R2BucketLike;
  const listed = await bucket.list();
  for (const one of listed.objects) {
    await bucket.delete(one.key);
  }
  return Effect.runPromise(
    body.pipe(Effect.orDie, Effect.provide(r2ObjectStoreLayer(bucket))),
  );
};

describe('the object store, on an R2 binding (Miniflare)', () => {
  it('round-trips a body and stamps it with an etag', async () => {
    const result = await withStore(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        const etag = yield* store.put('a/b', bytes('hello'));
        const found = yield* store.get('a/b');
        const missing = yield* store.get('nope');
        return { etag, found, missing };
      }),
    );

    expect(result.etag.length).toBeGreaterThan(0);
    expect(
      Option.isSome(result.found) ? text(result.found.value.body) : undefined,
    ).toBe('hello');
    expect(Option.isNone(result.missing)).toBe(true);
  });

  it('refuses a create when the key is already there', async () => {
    const failure = await withStore(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        yield* store.put('a', bytes('one'));
        return yield* Effect.flip(store.put('a', bytes('two'), ifAbsent()));
      }),
    );

    expect(failure._tag).toBe('PreconditionFailed');
  });

  it('refuses a stale etag and takes the current one', async () => {
    const result = await withStore(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        const first = yield* store.put('a', bytes('one'));
        const stale = yield* Effect.flip(
          store.put('a', bytes('two'), ifHolds({ etag: 'deadbeef' })),
        );
        const fresh = yield* store.put(
          'a',
          bytes('two'),
          ifHolds({ etag: first }),
        );
        const read = yield* store.get('a');
        return { stale, fresh, read };
      }),
    );

    expect(result.stale._tag).toBe('PreconditionFailed');
    expect(result.fresh.length).toBeGreaterThan(0);
    expect(
      Option.isSome(result.read) ? text(result.read.value.body) : undefined,
    ).toBe('two');
  });

  it('deletes an object so it reads absent afterwards', async () => {
    const result = await withStore(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        yield* store.put('a', bytes('one'));
        yield* store.delete('a');
        return yield* store.get('a');
      }),
    );

    expect(Option.isNone(result)).toBe(true);
  });

  it('lists by prefix and pages with a cursor', async () => {
    const result = await withStore(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        yield* store.put('k/a', bytes('a'));
        yield* store.put('k/b', bytes('b'));
        yield* store.put('k/c', bytes('c'));
        yield* store.put('z/one', bytes('z'));
        const first = yield* store.list({ prefix: 'k/', limit: 2 });
        const cursor = first.cursor;
        const second =
          cursor === undefined
            ? undefined
            : yield* store.list({ prefix: 'k/', limit: 2, cursor });
        return { first: first.keys, cursor, second: second?.keys };
      }),
    );

    expect(result.first).toEqual(['k/a', 'k/b']);
    expect(result.cursor).toBeDefined();
    expect(result.second).toEqual(['k/c']);
  });

  it('lets one of two racing creates win, and refuses the other', async () => {
    const result = await withStore(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        const attempt = (value: string) =>
          store.put('a', bytes(value), ifAbsent()).pipe(
            Effect.as('written'),
            Effect.catchTag('PreconditionFailed', () =>
              Effect.succeed('refused'),
            ),
          );
        const raced = yield* Effect.all([attempt('one'), attempt('two')], {
          concurrency: 'unbounded',
        });
        return raced.sort();
      }),
    );

    expect(result).toEqual(['refused', 'written']);
  });

  it('refuses a conditional delete rather than racing one', async () => {
    const failure = await withStore(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        const etag = yield* store.put('a', bytes('one'));
        return yield* Effect.flip(store.delete('a', ifHolds({ etag })));
      }),
    );

    expect(failure._tag).toBe('ObjectStoreUnavailable');
  });
});
