import { Data, Match } from 'effect';

/**
 * AppView read / index freshness, against the spec
 * (`packages/specs/specs/appview/read-freshness.qnt`).
 *
 * Reads are served from a projection snapshot that lags the canonical index:
 * the index advances as records apply, the projection catches up in batches,
 * and a read may only be served from a snapshot the projection has already
 * materialised. "fresh" means the projection has caught up to the index.
 *
 * The spec's `nondet step` / `nondet snapshot` are pools the scenario picks
 * from; the rule takes the chosen step as a domain value, so the differential
 * test beside it is what maps a trace's pick onto that value.
 */

/** The spec's variables, as the machine's fields. */
export type ReadFreshnessFields = {
  /** The canonical index version. */
  readonly indexVersion: bigint;
  /** The read projection version (lags the index). */
  readonly projectionVersion: bigint;
  /** The snapshot the last read was served from. */
  readonly servedVersion: bigint;
  /** "fresh" | "lagging". */
  readonly state: string;
};

/** A machine that has not started. */
export const idleReadFreshness = () => ({
  indexVersion: 0n,
  projectionVersion: 0n,
  servedVersion: 0n,
  state: 'fresh',
});

/** The spec's events, as constructors. */
type ReadFreshnessEventMap = Data.TaggedEnum<{
  readonly init: {};
  /** Canonical records apply: the step the index advances by. */
  readonly advanceIndex: { readonly step: bigint };
  /** The projection catches up: the step it advances by. */
  readonly refreshProjection: { readonly step: bigint };
  /** A read from the chosen snapshot. */
  readonly read: { readonly snapshot: bigint };
}>;

export const {
  init: freshnessInit,
  advanceIndex: freshnessAdvanceIndex,
  refreshProjection: freshnessRefreshProjection,
  read: freshnessRead,
} = Data.taggedEnum<ReadFreshnessEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const readFreshnessStep = (params: {
  readonly fields: ReadFreshnessFields;
  readonly event: ReadFreshnessEventMap;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleReadFreshness(),

      advanceIndex: ({ step }) => {
        const indexVersion = fields.indexVersion + step;

        return {
          ...fields,
          indexVersion,
          state: fields.projectionVersion < indexVersion ? 'lagging' : 'fresh',
        };
      },

      refreshProjection: ({ step }) => {
        // The projection catches up toward the index, never overshooting it.
        const reaches = fields.projectionVersion + step >= fields.indexVersion;

        return {
          ...fields,
          projectionVersion: reaches
            ? fields.indexVersion
            : fields.projectionVersion + step,
          state: reaches ? 'fresh' : 'lagging',
        };
      },

      read: ({ snapshot }) => ({
        ...fields,
        // A snapshot the projection lacks is refused, leaving the last served
        // version in place.
        servedVersion:
          snapshot <= fields.projectionVersion
            ? snapshot
            : fields.servedVersion,
      }),
    }),
  );
};
