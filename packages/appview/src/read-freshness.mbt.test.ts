import {
  type ReadFreshnessFields,
  freshnessAdvanceIndex,
  freshnessInit,
  freshnessRead,
  freshnessRefreshProjection,
  idleReadFreshness,
  readFreshnessStep,
} from './read-freshness.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for read/index freshness: `quint run` traces from the
 * spec, replayed against `read-freshness.ts` and compared to the model -
 * including `IndexConsistent` (the projection never passes the index) and
 * `NoReadAheadOfProjection` (a read never passes the projection).
 */

const bigint: StandardSchemaV1<unknown, bigint> = {
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
    advanceIndex: { step: bigint },
    refreshProjection: { step: bigint },
    read: { snapshot: bigint },
  },
  () => {
    const freshness = { fields: idleReadFreshness() } satisfies {
      fields: ReadFreshnessFields;
    };
    const step = (event: Parameters<typeof readFreshnessStep>[0]['event']) => {
      freshness.fields = readFreshnessStep({ fields: freshness.fields, event });
    };

    return {
      init: async () => step(freshnessInit()),
      advanceIndex: async ({ step: indexStep }) =>
        step(freshnessAdvanceIndex({ step: indexStep })),
      refreshProjection: async ({ step: projectionStep }) =>
        step(freshnessRefreshProjection({ step: projectionStep })),
      read: async ({ snapshot }) => step(freshnessRead({ snapshot })),
      getState: () => freshness.fields,
    };
  },
);

describe('appview read freshness (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/appview/read-freshness.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '646464',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              indexVersion: Schema.BigInt,
              projectionVersion: Schema.BigInt,
              servedVersion: Schema.BigInt,
              state: Schema.String,
            }),
          )(raw),
        (spec, impl) =>
          spec.indexVersion === impl.indexVersion &&
          spec.projectionVersion === impl.projectionVersion &&
          spec.servedVersion === impl.servedVersion &&
          spec.state === impl.state,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
