import {
  type AggregationFields,
  aggregationAck,
  aggregationAppendBatch,
  aggregationBackfillAck,
  aggregationGoLive,
  aggregationInit,
  aggregationStartBackfill,
  aggregationStep,
  coldAggregation,
} from './aggregation.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for aggregation and backfill: `quint run` traces from the
 * spec, replayed against `aggregation.ts` and compared to the model - including
 * `AckNeverAhead` and `BackfillTargetWithinFeed`, the two clamps the rules exist
 * to keep.
 */

const bigint: StandardSchemaV1<unknown, bigint> = {
  '~standard': {
    version: 1,
    vendor: 'sync',
    validate: (value) =>
      typeof value === 'bigint'
        ? { value }
        : { issues: [{ message: `expected bigint, got ${typeof value}` }] },
  },
};

const driver = defineDriver(
  {
    init: {},
    goLive: {},
    appendBatch: { n: bigint },
    ack: { n: bigint },
    startBackfill: { from: bigint },
    backfillAck: { n: bigint },
  },
  () => {
    const relay = { fields: coldAggregation() } satisfies {
      fields: AggregationFields;
    };
    const step = (event: Parameters<typeof aggregationStep>[0]['event']) => {
      relay.fields = aggregationStep({ fields: relay.fields, event });
    };

    return {
      init: async () => step(aggregationInit()),
      goLive: async () => step(aggregationGoLive()),
      appendBatch: async ({ n }) => step(aggregationAppendBatch({ n })),
      ack: async ({ n }) => step(aggregationAck({ n })),
      startBackfill: async ({ from }) =>
        step(aggregationStartBackfill({ from })),
      backfillAck: async ({ n }) => step(aggregationBackfillAck({ n })),
      getState: () => relay.fields,
    };
  },
);

describe('relay aggregation (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL('../../specs/specs/relay/aggregation.qnt', import.meta.url)
        .pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '818181',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              status: Schema.String,
              feedSeq: Schema.BigInt,
              ackSeq: Schema.BigInt,
              backfillTarget: Schema.BigInt,
            }),
          )(raw),
        (spec, impl) =>
          spec.status === impl.status &&
          spec.feedSeq === impl.feedSeq &&
          spec.ackSeq === impl.ackSeq &&
          spec.backfillTarget === impl.backfillTarget,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
