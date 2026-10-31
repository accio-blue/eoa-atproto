import { type BackfillPage, type BackfillSourceShape } from './pds-source.js';
import { Effect, Ref, Stream } from 'effect';
import { IndexStore, indexStoreLayer } from './index-store.js';
import { describe, expect, it } from 'vitest';
import { reconcileBackfill } from './reconcile.js';

/**
 * The reconcile loop's contract: history and the live stream land in one index
 * without double-indexing or dropping. Each case runs against a real
 * `indexStoreLayer` and one fake source, in its own provided scenario, so the
 * store assertions see exactly the run they describe.
 */

const DID = 'did:plc:genesis';
const HISTORICAL_TARGET = 'at://did:plc:bob/app.bsky.feed.post/hist';
const LIVE_TARGET = 'at://did:plc:carol/app.bsky.feed.post/live';

/** The source URI a like with this rkey produces in the index. */
const uriOf = (rkey: string) => `at://${DID}/app.bsky.feed.like/${rkey}`;

/** A historical like whose value names one target. */
const likeOf = (params: {
  readonly target: string;
  readonly rkey: string;
}) => ({
  did: DID,
  collection: 'app.bsky.feed.like',
  rkey: params.rkey,
  record: {
    $type: 'app.bsky.feed.like',
    subject: { uri: params.target },
  },
});

/** A live create frame whose record names one target. */
const frameOf = (params: {
  readonly target: string;
  readonly rkey: string;
  readonly time: number;
}) => ({
  did: DID,
  time_us: params.time,
  collection: 'app.bsky.feed.like',
  rkey: params.rkey,
  operation: 'create',
  record: {
    $type: 'app.bsky.feed.like',
    subject: { uri: params.target },
  },
});

/** Give each page but the last a cursor pointing at the next one. */
const paged = (pages: ReadonlyArray<BackfillPage['records']>) =>
  pages.map((records, index) =>
    index + 1 < pages.length
      ? { records, cursor: String(index + 1) }
      : { records },
  );

/** A source that serves `pages` in order and stops where they stop. */
const backfillFrom = (pages: ReadonlyArray<BackfillPage>) =>
  ({
    pageOf: (params: {
      readonly did: string;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    }) =>
      Effect.succeed(
        pages[params.cursor === undefined ? 0 : Number(params.cursor)] ?? {
          records: [],
        },
      ),
  }) satisfies BackfillSourceShape;

describe('reconcileBackfill', () => {
  it('indexes a historical page and a live frame, reporting the last time_us', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexStore;
        const source = backfillFrom(
          paged([[likeOf({ target: HISTORICAL_TARGET, rkey: 'hist' })]]),
        );

        const outcome = yield* reconcileBackfill({
          store,
          source,
          did: DID,
          target: 1n,
          live: Stream.fromIterable([
            frameOf({ target: LIVE_TARGET, rkey: 'live', time: 123 }),
          ]),
        });

        return {
          outcome,
          historical: yield* store.backlinksOf(HISTORICAL_TARGET),
          live: yield* store.backlinksOf(LIVE_TARGET),
        };
      }).pipe(Effect.provide(indexStoreLayer)),
    );

    expect(result.historical).toEqual([uriOf('hist')]);
    expect(result.live).toEqual([uriOf('live')]);
    expect(result.outcome.mode).toBe('live');
    // One backfill position plus one live position.
    expect(result.outcome.entries).toBe(2n);
    expect(result.outcome.liveCursor).toBe(123);
  });

  it('holds a frame delivered while backfilling until after handover', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexStore;
        const during = yield* Ref.make<readonly string[]>([]);
        const source: BackfillSourceShape = {
          pageOf: () =>
            Effect.gen(function* () {
              const held = yield* store.backlinksOf(LIVE_TARGET);
              yield* Ref.set(during, held);
              return {
                records: [likeOf({ target: HISTORICAL_TARGET, rkey: 'hist' })],
              };
            }),
        };

        const outcome = yield* reconcileBackfill({
          store,
          source,
          did: DID,
          target: 1n,
          live: Stream.fromIterable([
            frameOf({ target: LIVE_TARGET, rkey: 'live', time: 55 }),
          ]),
        });

        return {
          outcome,
          before: yield* Ref.get(during),
          after: yield* store.backlinksOf(LIVE_TARGET),
        };
      }).pipe(Effect.provide(indexStoreLayer)),
    );

    // The frame was in hand, but not in the index, while history was read.
    expect(result.before).toEqual([]);
    expect(result.after).toEqual([uriOf('live')]);
    expect(result.outcome.liveCursor).toBe(55);
  });

  it('never indexes a target twice for one source', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexStore;
        const source = backfillFrom(
          paged([[likeOf({ target: HISTORICAL_TARGET, rkey: 'same' })]]),
        );

        const outcome = yield* reconcileBackfill({
          store,
          source,
          did: DID,
          target: 1n,
          live: Stream.fromIterable([
            frameOf({ target: HISTORICAL_TARGET, rkey: 'same', time: 9 }),
          ]),
        });

        return {
          outcome,
          backlinks: yield* store.backlinksOf(HISTORICAL_TARGET),
        };
      }).pipe(Effect.provide(indexStoreLayer)),
    );

    // The same (target, source) pair offered by history and by live is one
    // entry, and the live frame was still applied rather than dropped.
    expect(result.backlinks).toEqual([uriOf('same')]);
    expect(result.outcome.liveCursor).toBe(9);
  });
});
