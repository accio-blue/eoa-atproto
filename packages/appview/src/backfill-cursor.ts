import { Data, Match } from 'effect';

/**
 * The AppView's canonical backfill/live cursor reconciliation, against the spec
 * (`packages/specs/specs/appview/backfill-cursor.qnt`).
 *
 * A backfill replays history up to a target sequence while the live stream keeps
 * delivering newer records. The two sources reconcile around one cursor: live
 * deliveries below the backfill point are ignored (history owns them), live
 * deliveries beyond it are deferred until handover, and a stale backfill page
 * never re-applies a sequence already covered. Reaching the target hands over
 * to live; deferred deliveries then drain in order.
 *
 * This is the SPA read side's own reconciler - distinct from the backlink
 * index's `backfill-live.ts`, which tracks indexed `entries` and carries an
 * `EntriesCoverHighest` invariant. Here there is no index: only the cursor
 * position matters, and handover consistency is the property that guards it.
 */

/** The reconciler's fields, as the spec declares them. */
export type BackfillCursorFields = {
  readonly mode: string;
  /** The sequence the backfill must reach. */
  readonly target: bigint;
  /** The highest sequence covered by the backfill. */
  readonly backfillCursor: bigint;
  /** The highest sequence applied from the live stream. */
  readonly liveCursor: bigint;
  /** Live deliveries held until handover. */
  readonly deferred: bigint;
};

/** A reconciler that has not started. */
export const idleBackfillCursor = () => ({
  mode: 'idle',
  target: 0n,
  backfillCursor: 0n,
  liveCursor: 0n,
  deferred: 0n,
});

/** The spec's events, as constructors. */
type BackfillCursorEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly startBackfill: { readonly startTarget: bigint };
  /** One backfill page, which advanced to `seq`. */
  readonly backfillEvent: { readonly seq: bigint };
  /** One live delivery at `seq`. */
  readonly liveEvent: { readonly seq: bigint };
  readonly drainDeferred: {};
}>;

export const {
  init: cursorInit,
  startBackfill: cursorStart,
  backfillEvent: cursorPage,
  liveEvent: cursorLive,
  drainDeferred: cursorDrain,
} = Data.taggedEnum<BackfillCursorEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const backfillCursorStep = (params: {
  readonly fields: BackfillCursorFields;
  readonly event: BackfillCursorEventMap;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleBackfillCursor(),

      startBackfill: ({ startTarget }) => ({
        mode: 'backfilling',
        target: startTarget,
        backfillCursor: 0n,
        liveCursor: 0n,
        deferred: 0n,
      }),

      backfillEvent: ({ seq }) => {
        const backfilling = fields.mode === 'backfilling';
        const reaches = backfilling && seq >= fields.target;
        const advances = backfilling && seq > fields.backfillCursor;

        return {
          ...fields,
          mode: reaches ? 'live' : fields.mode,
          // A stale page is ignored; a forward page advances to at most the
          // target, and reaching it hands over to live without jumping past.
          backfillCursor: advances
            ? reaches
              ? fields.target
              : seq
            : fields.backfillCursor,
          liveCursor: reaches ? fields.target : fields.liveCursor,
        };
      },

      liveEvent: ({ seq }) => {
        const applied = fields.mode === 'live' && seq > fields.liveCursor;

        return {
          ...fields,
          liveCursor: applied ? seq : fields.liveCursor,
          deferred:
            fields.mode === 'backfilling' && seq > fields.target
              ? fields.deferred + 1n
              : fields.deferred,
        };
      },

      drainDeferred: () => {
        const draining = fields.mode === 'live' && fields.deferred > 0n;

        return {
          ...fields,
          liveCursor: draining ? fields.liveCursor + 1n : fields.liveCursor,
          deferred: draining ? fields.deferred - 1n : fields.deferred,
        };
      },
    }),
  );
};
