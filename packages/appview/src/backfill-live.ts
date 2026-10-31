import { Data, Match } from 'effect';

/**
 * Reconciling the PDS backfill with the live stream, against the spec
 * (`packages/specs/specs/backlink-index/backfill-live.qnt`).
 *
 * Our relays are non-archival, so history is backfilled by crawling PDSes while
 * the live subscription keeps delivering newer references. The two reconcile
 * around one ordinal: a live delivery at or below the backfill point is already
 * covered by history and is ignored, one beyond it is deferred until handover,
 * and reaching the target hands over to live. The index ends up holding every
 * ordinal either source covered, exactly once - `EntriesCoverHighest` and
 * `IndexMonotonic` are the properties that say so.
 */

/** The reconciler's fields, as the spec declares them. */
export type BackfillLiveFields = {
  readonly mode: string;
  /** The ordinal the backfill must reach. */
  readonly target: bigint;
  /** The highest ordinal covered by the backfill. */
  readonly backfillCursor: bigint;
  /** The highest ordinal applied from the live stream. */
  readonly liveCursor: bigint;
  /** Live deliveries held until handover. */
  readonly deferred: bigint;
  /** Distinct indexed entries. */
  readonly entries: bigint;
};

const maxOf = (left: bigint, right: bigint) => (left > right ? left : right);

/** A forward page advances to at most the target; a stale page is ignored. */
const advancedTo = (params: {
  readonly backfillCursor: bigint;
  readonly seq: bigint;
  readonly target: bigint;
  readonly backfilling: boolean;
  readonly reaches: boolean;
}) => {
  if (!(params.backfilling && params.seq > params.backfillCursor)) {
    return params.backfillCursor;
  }

  return params.reaches ? params.target : params.seq;
};

/** A reconciler that has not started. */
export const idleBackfill = () => ({
  mode: 'idle',
  target: 0n,
  backfillCursor: 0n,
  liveCursor: 0n,
  deferred: 0n,
  entries: 0n,
});

/** The spec's events, as constructors. */
type BackfillLiveEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly startBackfill: { readonly startTarget: bigint };
  /** One backfill page, which advanced to `seq`. */
  readonly backfillPage: { readonly seq: bigint };
  /** One live delivery at `seq`. */
  readonly liveEvent: { readonly seq: bigint };
  readonly drainDeferred: {};
}>;

export const {
  init: backfillInit,
  startBackfill: backfillStart,
  backfillPage,
  liveEvent: backfillLiveEvent,
  drainDeferred: backfillDrain,
} = Data.taggedEnum<BackfillLiveEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const backfillLiveStep = (params: {
  readonly fields: BackfillLiveFields;
  readonly event: BackfillLiveEventMap;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleBackfill(),

      startBackfill: ({ startTarget }) => ({
        mode: 'backfilling',
        target: startTarget,
        backfillCursor: 0n,
        liveCursor: 0n,
        deferred: 0n,
        entries: 0n,
      }),

      backfillPage: ({ seq }) => {
        const backfilling = fields.mode === 'backfilling';
        const reaches = backfilling && seq >= fields.target;
        // A stale page is ignored; a forward page advances to at most the
        // target, and reaching it hands over to live.
        const advanced = advancedTo({
          backfillCursor: fields.backfillCursor,
          seq,
          target: fields.target,
          backfilling,
          reaches,
        });
        const covered = reaches ? fields.target : fields.liveCursor;

        return {
          ...fields,
          mode: reaches ? 'live' : fields.mode,
          backfillCursor: advanced,
          liveCursor: covered,
          entries: maxOf(advanced, covered),
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
          entries: maxOf(
            fields.backfillCursor,
            applied ? seq : fields.liveCursor,
          ),
        };
      },

      drainDeferred: () => {
        const draining = fields.mode === 'live' && fields.deferred > 0n;
        const liveCursor = draining
          ? fields.liveCursor + 1n
          : fields.liveCursor;

        return {
          ...fields,
          liveCursor,
          deferred: draining ? fields.deferred - 1n : fields.deferred,
          entries: maxOf(fields.backfillCursor, liveCursor),
        };
      },
    }),
  );
};
