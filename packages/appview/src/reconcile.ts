import {
  type BackfillLiveFields,
  backfillDrain,
  backfillLiveEvent,
  backfillLiveStep,
  backfillPage,
  backfillStart,
  idleBackfill,
} from './backfill-live.js';
import {
  type BackfillPage,
  type BackfillSourceShape,
  indexPage,
} from './pds-source.js';
import { Cause, Effect, Exit, Fiber, Option, Queue, Ref, Stream } from 'effect';
import { type IndexFrame, LiveIngestError } from './live.js';
import { type IndexStoreShape } from './index-store.js';
import { indexRecord } from './ingest.js';

/**
 * The loop that reconciles the PDS backfill with the live stream into one
 * backlink index, against the spec
 * (`packages/specs/specs/backlink-index/backfill-live.qnt`).
 *
 * ## The ordinal mapping (frozen)
 *
 * The spec compares `backfillPage`'s and `liveEvent`'s `seq` on one scale, so
 * this loop gives both one meaning: **the index's own log position**. It is not
 * a clock. `IndexFrame.time_us` is a relay timestamp that repeats across a
 * reconnect, so feeding it to `backfillLiveStep` would make a replay look like
 * fresh coverage; the transport high-water is kept separately and is what the
 * returned `liveCursor` reports.
 *
 * - A backfill page takes the position of its page: page `k` is ordinal `k`, so
 *   reading `target` pages drives `backfillCursor` from 0 to `target`. That is
 *   why `target` is both "the ordinal to reach" and "the number of pages to
 *   read".
 * - A live frame takes the position after the backfill's. The frames held in
 *   the queue while history is read are numbered `target + 1`, `target + 2`,
 *   ... in arrival order, so live coverage begins strictly above the handover
 *   point and no ordinal is claimed by both sources.
 *
 * Why the spec's invariants hold under this mapping:
 *
 * - `BackfillWithinTarget` - page `k` is stepped at most once with `k <=
 *   target`, and `backfillPage` clamps a reaching page to `target`.
 * - `HandoffConsistent` - handover is the single `backfillPage({ seq: target })`
 *   step, so `mode == "live"` implies `backfillCursor == target`.
 * - `NoDoubleIndex` - the backfill covers `1..target` and live numbering starts
 *   at `target + 1`, so any applied live ordinal satisfies `liveCursor >=
 *   target`.
 * - `CursorMonotonic` - after handover the cursor only advances, one held frame
 *   at a time, through `backfillDrain`.
 * - `EntriesCoverHighest` - every state change goes through `backfillLiveStep`;
 *   `entries` is the rule's `max(backfillCursor, liveCursor)`, never a tally
 *   kept here.
 *
 * An exhausted repository (a page with no cursor before `target` pages) still
 * hands over at `target`: the remaining positions are empty, so claiming them
 * covers no record and loses none.
 */

/** The backfill reader's position: the source cursor and the pages read. */
type PageState = {
  readonly cursor: string | undefined;
  readonly pageNumber: bigint;
};

/** One page read, tagged with the ordinal (its page number) it covers. */
type OrdinalPage = {
  readonly page: BackfillPage;
  readonly pageNumber: bigint;
};

/** What one paginate step yields: its pages, and where to read next. */
type PageStep = readonly [ReadonlyArray<OrdinalPage>, Option.Option<PageState>];

export const reconcileBackfill: (params: {
  readonly store: IndexStoreShape;
  readonly source: BackfillSourceShape;
  readonly did: string;
  /** How many pages of history the backfill must read before handover. */
  readonly target: bigint;
  /** The live stream, consumed concurrently with the backfill. */
  readonly live: Stream.Stream<IndexFrame, LiveIngestError>;
}) => Effect.Effect<
  {
    readonly mode: string;
    readonly entries: bigint;
    readonly deferred: bigint;
    readonly liveCursor: number;
  },
  LiveIngestError
> = (params) =>
  Effect.gen(function* () {
    // The live stream is drained into a queue for the duration of the
    // backfill; nothing it carries is applied until handover.
    const queue = yield* Queue.unbounded<
      IndexFrame,
      LiveIngestError | Cause.Done
    >();
    const producer = yield* params.live.pipe(
      Stream.runForEach((frame) => Queue.offer(queue, frame)),
      Effect.forkScoped,
    );

    const fields = yield* Ref.make<BackfillLiveFields>(
      backfillLiveStep({
        fields: idleBackfill(),
        event: backfillStart({ startTarget: params.target }),
      }),
    );

    // Give the live stream a slice to deliver into the queue before history
    // starts, so a frame that arrives during the backfill is held, not lost.
    yield* Effect.yieldNow;

    // History, page by page: emit page `k` with ordinal `k`, stopping after
    // `target` pages or when the source runs out of cursor.
    const start: PageState = { cursor: undefined, pageNumber: 0n };
    const pages = Stream.paginate(start, (state) =>
      Effect.gen(function* () {
        if (state.pageNumber >= params.target) {
          const done: PageStep = [[], Option.none<PageState>()];
          return done;
        }

        const page = yield* params.source.pageOf({
          did: params.did,
          cursor: state.cursor,
        });
        const pageNumber = state.pageNumber + 1n;
        const last = page.cursor === undefined || pageNumber >= params.target;
        const next = last
          ? Option.none<PageState>()
          : Option.some({ cursor: page.cursor, pageNumber });
        const step: PageStep = [[{ page, pageNumber }], next];
        return step;
      }),
    ).pipe(
      Stream.mapError(
        (cause) => new LiveIngestError({ message: cause.message }),
      ),
    );

    yield* Stream.runForEach(pages, ({ page, pageNumber }) =>
      Effect.gen(function* () {
        yield* indexPage({ store: params.store, page });
        // The reaching page's step is held back: it is the handover, and the
        // held live frames must be counted before it fires.
        if (pageNumber < params.target) {
          yield* Ref.update(fields, (current) =>
            backfillLiveStep({
              fields: current,
              event: backfillPage({ seq: pageNumber }),
            }),
          );
        }
      }),
    );

    // Stop the producer so the queue is frozen, then surface a real stream
    // failure. An interruption of our own is expected, not an error.
    yield* Fiber.interrupt(producer);
    const outcome = yield* Fiber.await(producer);
    if (Exit.isFailure(outcome) && !Cause.hasInterruptsOnly(outcome.cause)) {
      return yield* Effect.failCause(outcome.cause);
    }

    yield* Queue.end(queue);
    const held = yield* Queue.collect(queue);

    // Every held frame arrived while backfilling: count it as deferred while
    // still in "backfilling", then hand over, then drain it in arrival order.
    yield* Effect.forEach(
      held,
      (_frame, index) =>
        Ref.update(fields, (current) =>
          backfillLiveStep({
            fields: current,
            event: backfillLiveEvent({
              seq: params.target + 1n + BigInt(index),
            }),
          }),
        ),
      { discard: true },
    );

    yield* Ref.update(fields, (current) =>
      backfillLiveStep({
        fields: current,
        event: backfillPage({ seq: params.target }),
      }),
    );

    yield* Effect.forEach(
      held,
      (frame) =>
        Effect.gen(function* () {
          yield* indexRecord({
            store: params.store,
            observed: {
              did: frame.did,
              collection: frame.collection,
              rkey: frame.rkey,
              record: frame.record,
            },
          });
          yield* Ref.update(fields, (current) =>
            backfillLiveStep({ fields: current, event: backfillDrain() }),
          );
        }),
      { discard: true },
    );

    const state = yield* Ref.get(fields);
    const liveCursor = held.reduce(
      (max, frame) => (frame.time_us > max ? frame.time_us : max),
      0,
    );

    return {
      mode: state.mode,
      entries: state.entries,
      deferred: state.deferred,
      liveCursor,
    };
  }).pipe(Effect.scoped);
