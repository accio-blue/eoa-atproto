import {
  IndexStore,
  type IndexStoreShape,
  indexStoreLayer,
} from './index-store.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

/**
 * The store's contract: `offer` answers novelty from the pairs it holds, and
 * the accounting it exposes is the spec's `targetIndexStep`, not a parallel
 * tally. Every case runs its whole seed-and-assert inside one provided layer,
 * since the store is rebuilt per `Effect.provide`.
 */

const TARGET_A = 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a';
const TARGET_B = 'at://did:web:example.com/app.bsky.feed.post/3k2la9x8w1';
const SOURCE_LIKE = 'at://did:plc:genesis/app.bsky.feed.like/3jzsm4zqb2s2b';
const SOURCE_COMMENT = 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2c';

/** Run one scenario against a fresh store. */
const withStore = <A>(use: (store: IndexStoreShape) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* IndexStore;
      return yield* use(store);
    }).pipe(Effect.provide(indexStoreLayer)),
  );

describe('IndexStore', () => {
  it('adds a fresh reference and reports it novel', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        const novel = yield* store.offer({
          target: TARGET_A,
          source: SOURCE_LIKE,
        });
        const backlinks = yield* store.backlinksOf(TARGET_A);
        return { novel, backlinks };
      }),
    );

    expect(result.novel).toBe(true);
    expect(result.backlinks).toEqual([SOURCE_LIKE]);
  });

  it('does not grow the index for a pair already present', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.offer({ target: TARGET_A, source: SOURCE_LIKE });
        const again = yield* store.offer({
          target: TARGET_A,
          source: SOURCE_LIKE,
        });
        const backlinks = yield* store.backlinksOf(TARGET_A);
        const { entries, observed, duplicates } = yield* store.accounting;
        return { again, backlinks, entries, observed, duplicates };
      }),
    );

    expect(result.again).toBe(false);
    expect(result.backlinks).toEqual([SOURCE_LIKE]);
    expect(result.entries).toBe(1n);
    expect(result.observed).toBe(2n);
    expect(result.duplicates).toBe(1n);
  });

  it('adds a source to a second target and a second source to the same target', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.offer({ target: TARGET_A, source: SOURCE_LIKE });
        const secondTarget = yield* store.offer({
          target: TARGET_B,
          source: SOURCE_LIKE,
        });
        const secondSource = yield* store.offer({
          target: TARGET_A,
          source: SOURCE_COMMENT,
        });
        const targetA = yield* store.backlinksOf(TARGET_A);
        const targetB = yield* store.backlinksOf(TARGET_B);
        return { secondTarget, secondSource, targetA, targetB };
      }),
    );

    expect(result.secondTarget).toBe(true);
    expect(result.secondSource).toBe(true);
    expect(result.targetA).toEqual([SOURCE_LIKE, SOURCE_COMMENT]);
    expect(result.targetB).toEqual([SOURCE_LIKE]);
  });

  it('retracts a reference once', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.offer({ target: TARGET_A, source: SOURCE_LIKE });
        const first = yield* store.retract({
          target: TARGET_A,
          source: SOURCE_LIKE,
        });
        const again = yield* store.retract({
          target: TARGET_A,
          source: SOURCE_LIKE,
        });
        const backlinks = yield* store.backlinksOf(TARGET_A);
        return { first, again, backlinks };
      }),
    );

    expect(result.first).toBe(true);
    expect(result.again).toBe(false);
    expect(result.backlinks).toEqual([]);
  });

  it('keeps targets separate, and an unknown target has no backlinks', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.offer({ target: TARGET_A, source: SOURCE_LIKE });
        yield* store.offer({ target: TARGET_B, source: SOURCE_COMMENT });
        const targetA = yield* store.backlinksOf(TARGET_A);
        const targetB = yield* store.backlinksOf(TARGET_B);
        const unknown = yield* store.backlinksOf(
          'at://unknown.app.bsky.feed.post/x',
        );
        return { targetA, targetB, unknown };
      }),
    );

    expect(result.targetA).toEqual([SOURCE_LIKE]);
    expect(result.targetB).toEqual([SOURCE_COMMENT]);
    expect(result.unknown).toEqual([]);
  });

  it('keeps the spec accounting exact after a mixed sequence', async () => {
    const fields = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.offer({ target: TARGET_A, source: SOURCE_LIKE });
        yield* store.offer({ target: TARGET_A, source: SOURCE_LIKE });
        yield* store.offer({ target: TARGET_A, source: SOURCE_COMMENT });
        yield* store.offer({ target: TARGET_B, source: SOURCE_LIKE });
        yield* store.retract({ target: TARGET_A, source: SOURCE_LIKE });
        yield* store.retract({ target: TARGET_B, source: SOURCE_COMMENT });
        return yield* store.accounting;
      }),
    );

    expect(fields.observed).toBe(
      fields.entries + fields.removed + fields.duplicates,
    );
    expect(fields.entries).toBe(2n);
    expect(fields.observed).toBe(4n);
    expect(fields.duplicates).toBe(1n);
    expect(fields.removed).toBe(1n);
  });
});
