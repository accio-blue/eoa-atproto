import {
  type IngestionPipelineFields,
  idleIngestion,
  ingestionApply,
  ingestionInit,
  ingestionPipelineStep,
  ingestionProject,
  ingestionReceive,
  ingestionStart,
} from './ingestion-pipeline.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the AppView ingest -> projection pipeline:
 * `quint run` traces from the spec, replayed against `ingestion-pipeline.ts`
 * and compared to the model - including `NoDoubleApply` and `IndexConsistent`.
 *
 * The spec's `receive` nondet is `delta`, the delivery's offset from the
 * cursor, so the driver declares the payload field as `delta` and passes the
 * domain value straight to the rule.
 */

const delta: StandardSchemaV1<unknown, bigint> = {
  '~standard': {
    version: 1,
    vendor: 'appview',
    validate: (value) =>
      typeof value === 'bigint'
        ? { value }
        : { issues: [{ message: `expected bigint, got ${typeof value}` }] },
  },
};

const driver = defineDriver(
  {
    init: {},
    start: {},
    receive: { delta },
    apply: {},
    project: {},
  },
  () => {
    const pipeline = { fields: idleIngestion() } satisfies {
      fields: IngestionPipelineFields;
    };
    const step = (
      event: Parameters<typeof ingestionPipelineStep>[0]['event'],
    ) => {
      pipeline.fields = ingestionPipelineStep({
        fields: pipeline.fields,
        event,
      });
    };

    return {
      init: async () => step(ingestionInit()),
      start: async () => step(ingestionStart()),
      receive: async ({ delta }) => step(ingestionReceive({ delta })),
      apply: async () => step(ingestionApply()),
      project: async () => step(ingestionProject()),
      getState: () => pipeline.fields,
    };
  },
);

describe('ingestion pipeline (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/appview/ingestion-pipeline.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '626262',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              stage: Schema.String,
              cursor: Schema.BigInt,
              buffered: Schema.BigInt,
              applied: Schema.BigInt,
              projected: Schema.BigInt,
            }),
          )(raw),
        (spec, impl) =>
          spec.stage === impl.stage &&
          spec.cursor === impl.cursor &&
          spec.buffered === impl.buffered &&
          spec.applied === impl.applied &&
          spec.projected === impl.projected,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
