import { Data, Match } from 'effect';

/**
 * The AppView's canonical ingest -> projection pipeline, against the spec
 * (`packages/specs/specs/appview/ingestion-pipeline.qnt`).
 *
 * Canonical records arrive from the live firehose and are applied to the
 * canonical index in sequence order, then materialised into the read
 * projection. The pipeline is single-writer: exactly one canonical record is
 * applied at a time, and projections drain the applied backlog. A forward gap
 * blocks the pipeline until a backfill closes it; a stale or duplicate
 * delivery is ignored. `NoDoubleApply` (applied never runs ahead of the
 * cursor) and `IndexConsistent` (projected <= applied <= cursor, buffered >= 0)
 * are the properties that say so.
 *
 * The rule takes the delivery's `delta` - its offset from the cursor - rather
 * than a model's scenario. The spec's only `nondet` is `delta` itself, so the
 * differential test beside it passes that domain value straight through.
 */

/** The pipeline's fields, as the spec declares them. */
export type IngestionPipelineFields = {
  readonly stage: string;
  /** Sequence number of the last canonical apply. */
  readonly cursor: bigint;
  /** Received but not yet applied. */
  readonly buffered: bigint;
  /** Records applied to the canonical index. */
  readonly applied: bigint;
  /** Records reflected in the read projection. */
  readonly projected: bigint;
};

/** A pipeline that has not started. */
export const idleIngestion = () => ({
  stage: 'idle',
  cursor: 0n,
  buffered: 0n,
  applied: 0n,
  projected: 0n,
});

/** The spec's events, as constructors. */
type IngestionPipelineEventMap = Data.TaggedEnum<{
  readonly init: {};
  /** Open the ingest stream. */
  readonly start: {};
  /** One delivery, with its offset from the cursor. */
  readonly receive: { readonly delta: bigint };
  /** Apply exactly one buffered record, advancing the cursor by one. */
  readonly apply: {};
  /** Materialise the next applied record into the read projection. */
  readonly project: {};
}>;

export const {
  init: ingestionInit,
  start: ingestionStart,
  receive: ingestionReceive,
  apply: ingestionApply,
  project: ingestionProject,
} = Data.taggedEnum<IngestionPipelineEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const ingestionPipelineStep = (params: {
  readonly fields: IngestionPipelineFields;
  readonly event: IngestionPipelineEventMap;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleIngestion(),

      start: () => ({ ...fields, stage: 'receiving' }),

      receive: ({ delta }) => {
        // delta == 1 buffers the next in-order record; delta > 1 blocks until a
        // backfill closes the gap; delta <= 0 is stale/duplicate and ignored.
        const inOrder = fields.stage === 'receiving' && delta === 1n;
        const gap = fields.stage === 'receiving' && delta > 1n;

        return {
          ...fields,
          stage: inOrder ? 'applying' : gap ? 'blocked' : fields.stage,
          buffered: inOrder ? fields.buffered + 1n : fields.buffered,
        };
      },

      apply: () => {
        const canApply = fields.buffered > 0n;

        return {
          ...fields,
          stage: canApply ? 'projecting' : fields.stage,
          buffered: canApply ? fields.buffered - 1n : fields.buffered,
          applied: canApply ? fields.applied + 1n : fields.applied,
          cursor: canApply ? fields.cursor + 1n : fields.cursor,
        };
      },

      project: () => {
        const canProject = fields.projected < fields.applied;

        return {
          ...fields,
          stage: canProject ? 'receiving' : fields.stage,
          projected: canProject ? fields.projected + 1n : fields.projected,
        };
      },
    }),
  );
};
