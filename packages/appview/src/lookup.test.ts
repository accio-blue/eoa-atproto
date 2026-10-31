import {
  BacklinkLookup,
  type LookupShape,
  backlinkLookupLayer,
} from './lookup.js';
import {
  type BacklinkRef,
  IndexStore,
  type IndexStoreShape,
} from './index-store.js';
import { Effect, Layer, Ref } from 'effect';
import { describe, expect, it } from 'vitest';
import { emptyTargetIndex } from './target-index.js';

/**
 * The backlink read, over an IndexStore that remembers whether it was read: the
 * visibility gate decides, and a hidden subject must not reach the store at
 * all.
 */

type LookupParams = Parameters<LookupShape['backlinks']>[0];

const TARGET = 'at://did:plc:alice/app.bsky.feed.post/3k';

const privateParams: LookupParams = {
  target: TARGET,
  visibility: 'private',
  grant: 'active',
  subjectMatchesViewer: true,
  selectorOk: true,
  expired: false,
};

const seed: readonly BacklinkRef[] = [
  { target: TARGET, source: 'at://did:plc:bob/app.bsky.feed.post/1' },
  { target: TARGET, source: 'at://did:plc:carol/app.bsky.feed.post/2' },
];

/** An index store that records every `backlinksOf` it serves. */
const trackingStore = () => {
  const reads: string[] = [];

  const layer = Layer.effect(
    IndexStore,
    Effect.gen(function* () {
      const held = yield* Ref.make(new Map<string, readonly string[]>());

      return {
        offer: (ref) =>
          Effect.gen(function* () {
            yield* Ref.update(held, (all) => {
              const sources = all.get(ref.target) ?? [];
              if (sources.includes(ref.source)) {
                return all;
              }
              return new Map(all).set(ref.target, [...sources, ref.source]);
            });
            return true;
          }),
        retractSource: () => Effect.succeed([]),
        retract: (ref) =>
          Effect.gen(function* () {
            yield* Ref.update(held, (all) =>
              new Map(all).set(
                ref.target,
                (all.get(ref.target) ?? []).filter(
                  (source) => source !== ref.source,
                ),
              ),
            );
            return true;
          }),
        backlinksOf: (target) =>
          Effect.gen(function* () {
            reads.push(target);
            const all = yield* Ref.get(held);
            return all.get(target) ?? [];
          }),
        accounting: Effect.succeed(emptyTargetIndex()),
      } satisfies IndexStoreShape;
    }),
  );

  return { layer, reads };
};

/** Seed and read inside one provided scenario, so the store is not rebuilt. */
const runLookup = (input: {
  readonly params: LookupParams;
  readonly seed: readonly BacklinkRef[];
}) => {
  const store = trackingStore();

  return Effect.gen(function* () {
    const index = yield* IndexStore;
    yield* Effect.forEach(input.seed, (ref) => index.offer(ref));
    const lookup = yield* BacklinkLookup;
    return yield* lookup.backlinks(input.params);
  }).pipe(
    Effect.provide(Layer.provideMerge(backlinkLookupLayer, store.layer)),
    Effect.map((result) => ({ result, reads: store.reads })),
  );
};

const sources = seed.map((ref) => ref.source).sort();

describe('the backlink lookup', () => {
  it('returns the sources of a public subject, and reads the store', async () => {
    const { result, reads } = await Effect.runPromise(
      runLookup({
        params: { ...privateParams, visibility: 'public', grant: 'none' },
        seed,
      }),
    );

    expect(result.decision).toBe('visible');
    expect([...result.sources].sort()).toEqual(sources);
    expect(reads).toEqual([TARGET]);
  });

  it('returns a private subject for an active, matching, unexpired grant', async () => {
    const { result, reads } = await Effect.runPromise(
      runLookup({ params: privateParams, seed }),
    );

    expect(result.decision).toBe('visible');
    expect([...result.sources].sort()).toEqual(sources);
    expect(reads).toEqual([TARGET]);
  });

  it('hides a revoked grant without reading the store', async () => {
    const { result, reads } = await Effect.runPromise(
      runLookup({ params: { ...privateParams, grant: 'revoked' }, seed }),
    );

    expect(result.decision).toBe('hidden');
    expect(result.sources).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('hides a subject that does not match the viewer', async () => {
    const { result, reads } = await Effect.runPromise(
      runLookup({
        params: { ...privateParams, subjectMatchesViewer: false },
        seed,
      }),
    );

    expect(result.decision).toBe('hidden');
    expect(result.sources).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('hides an expired grant', async () => {
    const { result, reads } = await Effect.runPromise(
      runLookup({ params: { ...privateParams, expired: true }, seed }),
    );

    expect(result.decision).toBe('hidden');
    expect(result.sources).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('is unresolved without visibility, and does not read the store', async () => {
    const { result, reads } = await Effect.runPromise(
      runLookup({ params: { ...privateParams, visibility: 'none' }, seed }),
    );

    expect(result.decision).toBe('none');
    expect(result.sources).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('is visible with no sources for a public subject nothing references', async () => {
    const { result, reads } = await Effect.runPromise(
      runLookup({
        params: { ...privateParams, visibility: 'public', grant: 'none' },
        seed: [],
      }),
    );

    expect(result.decision).toBe('visible');
    expect(result.sources).toEqual([]);
    expect(reads).toEqual([TARGET]);
  });
});
