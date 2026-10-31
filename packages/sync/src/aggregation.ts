import { Data, Match } from 'effect';
import type { RelayAggregationEvent } from '@eoa/specs/src/relay/aggregation.scaffolding.generated.js';

/**
 * Relay aggregation and backfill, implemented against the spec
 * (`packages/specs/specs/relay/aggregation.qnt`).
 *
 * The relay's own output firehose: upstream subscriptions feed one ordered feed,
 * the relay advances its sequence as it appends, each consumer's durable
 * checkpoint is recorded, and a consumer that falls behind is replayed from
 * storage. The property that matters is `AckNeverAhead` - the checkpoint can
 * never run past what was appended - and every update below is clamped for it.
 */

/** The aggregation's fields, as the spec declares them. */
export type AggregationFields = {
  readonly status: string;
  /** Relay firehose sequence: the last appended record. */
  readonly feedSeq: bigint;
  /** The consumer's durable checkpoint. */
  readonly ackSeq: bigint;
  /** The feed sequence a backfill must catch up to. */
  readonly backfillTarget: bigint;
};

/** A relay that has not gone live. */
export const coldAggregation = () => ({
  status: 'cold',
  feedSeq: 0n,
  ackSeq: 0n,
  backfillTarget: 0n,
});

/** The spec's events, as constructors. */
type AggregationEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly goLive: {};
  readonly appendBatch: { readonly n: bigint };
  readonly ack: { readonly n: bigint };
  readonly startBackfill: { readonly from: bigint };
  readonly backfillAck: { readonly n: bigint };
}>;

export const {
  init: aggregationInit,
  goLive: aggregationGoLive,
  appendBatch: aggregationAppendBatch,
  ack: aggregationAck,
  startBackfill: aggregationStartBackfill,
  backfillAck: aggregationBackfillAck,
} = Data.taggedEnum<AggregationEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const aggregationStep = (params: {
  readonly fields: AggregationFields;
  readonly event: RelayAggregationEvent;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => coldAggregation(),

      goLive: () => ({ ...fields, status: 'live' }),

      appendBatch: ({ n }) =>
        fields.status === 'live'
          ? { ...fields, feedSeq: fields.feedSeq + n }
          : fields,

      ack: ({ n }) => {
        const acked = fields.ackSeq + n;
        // Clamped to what was appended: a checkpoint is not a promise about
        // records the relay does not have.
        return {
          ...fields,
          ackSeq: acked > fields.feedSeq ? fields.feedSeq : acked,
        };
      },

      startBackfill: ({ from }) => ({
        ...fields,
        status: 'backfilling',
        ackSeq: from > fields.feedSeq ? fields.feedSeq : from,
        backfillTarget: fields.feedSeq,
      }),

      backfillAck: ({ n }) => {
        const acked = fields.ackSeq + n;
        const ackSeq =
          acked > fields.backfillTarget ? fields.backfillTarget : acked;
        return {
          ...fields,
          status:
            fields.status === 'backfilling' && acked >= fields.backfillTarget
              ? 'live'
              : fields.status,
          ackSeq,
        };
      },
    }),
  );
};
