import { Data, Match } from 'effect';

/**
 * The backlink index's live ingest, against the spec
 * (`packages/specs/specs/backlink-index/link-extraction.qnt`).
 *
 * An index of *references*, not content: for every record observed on the
 * stream, the references it carries are extracted and one index entry is
 * written per reference under the target it points at. The ingest cursor is
 * exactly the number of records consumed, which is what makes the stream's
 * position and the index's coverage the same number.
 *
 * The rule takes the references themselves rather than a model's scenario, so
 * the differential test beside it is what maps a trace's scenario onto the
 * references the spec's own `refsFor` describes.
 */

/** The spec's sentinel for "no reference yet". */
const NONE = 'none';

/** The extractor's fields, as the spec declares them. */
export type LinkExtractionFields = {
  readonly mode: string;
  /** The ingest sequence: one advance per observed record. */
  readonly cursor: bigint;
  readonly observed: bigint;
  readonly extracted: bigint;
  readonly indexed: bigint;
  /** The target of the last indexed reference. */
  readonly lastTarget: string;
  /** The record that carried it. */
  readonly lastSource: string;
};

/** An extractor that has not started. */
export const idleExtraction = () => ({
  mode: 'idle',
  cursor: 0n,
  observed: 0n,
  extracted: 0n,
  indexed: 0n,
  lastTarget: NONE,
  lastSource: NONE,
});

/** The spec's events, as constructors. */
type LinkExtractionEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly start: {};
  /** One record off the stream, with the references it carries. */
  readonly observe: {
    readonly source: string;
    readonly refs: readonly string[];
  };
  readonly pause: {};
}>;

export const {
  init: extractionInit,
  start: extractionStart,
  observe: extractionObserve,
  pause: extractionPause,
} = Data.taggedEnum<LinkExtractionEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const extractionStep = (params: {
  readonly fields: LinkExtractionFields;
  readonly event: LinkExtractionEventMap;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleExtraction(),

      start: () => ({ ...fields, mode: 'live' }),

      observe: ({ source, refs }) => {
        // A record observed while idle is not consumed: the ingest only
        // advances while it is subscribed.
        if (fields.mode !== 'live') {
          return fields;
        }
        const last = refs[refs.length - 1];

        return {
          ...fields,
          cursor: fields.cursor + 1n,
          observed: fields.observed + 1n,
          extracted: fields.extracted + BigInt(refs.length),
          indexed: fields.indexed + BigInt(refs.length),
          lastTarget: last === undefined ? fields.lastTarget : last,
          lastSource: refs.length === 0 ? fields.lastSource : source,
        };
      },

      pause: () => ({ ...fields, mode: 'idle' }),
    }),
  );
};
