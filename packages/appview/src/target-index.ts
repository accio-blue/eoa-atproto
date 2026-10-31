import { Data, Match } from 'effect';

/**
 * The target-keyed index and its dedupe, against the spec
 * (`packages/specs/specs/backlink-index/target-index.qnt`).
 *
 * The index is keyed by the referenced target and holds (target, source)
 * pairs. A pair offered twice does not grow the index - a record can reference
 * the same subject from two places, and the second is not a second backlink -
 * and a reorg or a delete retracts a pair, after which re-observing it is a
 * fresh offer again.
 *
 * Whether an offer is novel is the caller's answer (`novel`), because only the
 * caller holds the pairs: this rule is the arithmetic the spec fixes, and the
 * accounting it protects - every offer is exactly one live entry, one
 * duplicate, or one retraction.
 */

/** The index's fields, as the spec declares them. */
export type TargetIndexFields = {
  /** Live distinct (target, source) entries. */
  readonly entries: bigint;
  /** References offered to the index. */
  readonly observed: bigint;
  /** Offers that matched an entry already present. */
  readonly duplicates: bigint;
  /** Entries retracted by a reorg or a delete. */
  readonly removed: bigint;
  readonly lastTarget: string;
  readonly lastSource: string;
  readonly lastDup: boolean;
};

/** The sentinel for "no offer yet", as the spec's base defines it. */
const NONE = 'none';

/** An index with nothing in it. */
export const emptyTargetIndex = () => ({
  entries: 0n,
  observed: 0n,
  duplicates: 0n,
  removed: 0n,
  lastTarget: NONE,
  lastSource: NONE,
  lastDup: false,
});

/** The spec's events, as constructors. */
type TargetIndexEventMap = Data.TaggedEnum<{
  readonly init: {};
  /** A reference offered to the index; `novel` says it is a pair it lacks. */
  readonly offer: {
    readonly target: string;
    readonly source: string;
    readonly novel: boolean;
  };
  /** A reorg or delete retracts one entry, if there is one to retract. */
  readonly retract: {};
}>;

export const {
  init: indexInit,
  offer: indexOffer,
  retract: indexRetract,
} = Data.taggedEnum<TargetIndexEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const targetIndexStep = (params: {
  readonly fields: TargetIndexFields;
  readonly event: TargetIndexEventMap;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => emptyTargetIndex(),

      offer: ({ target, source, novel }) => ({
        ...fields,
        entries: novel ? fields.entries + 1n : fields.entries,
        observed: fields.observed + 1n,
        duplicates: novel ? fields.duplicates : fields.duplicates + 1n,
        lastTarget: target,
        lastSource: source,
        lastDup: !novel,
      }),

      retract: () => {
        // Retracting an empty index is a no-op: the index never goes below
        // zero, and the accounting stays exact.
        const had = fields.entries > 0n;

        return {
          ...fields,
          entries: had ? fields.entries - 1n : fields.entries,
          removed: had ? fields.removed + 1n : fields.removed,
          // A retraction is not an offer: the last offer's verdict no longer
          // describes anything, so the spec clears it.
          lastDup: false,
        };
      },
    }),
  );
};
