import {
  type BackfillLiveFields,
  backfillDrain,
  backfillInit,
  backfillLiveEvent,
  backfillLiveStep,
  backfillPage,
  backfillStart,
  idleBackfill,
} from './backfill-live.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the backfill/live reconciliation: `quint run`
 * traces from the spec, replayed against `backfill-live.ts` and compared to the
 * model - including `NoDoubleIndex` (the live stream never applies an ordinal
 * the backfill also covers), `HandoffConsistent` and `EntriesCoverHighest`.
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
    startBackfill: { startTarget: bigint },
    backfillPage: { seq: bigint },
    liveEvent: { seq: bigint },
    drainDeferred: {},
  },
  () => {
    const backfill = { fields: idleBackfill() } satisfies {
      fields: BackfillLiveFields;
    };
    const step = (event: Parameters<typeof backfillLiveStep>[0]['event']) => {
      backfill.fields = backfillLiveStep({ fields: backfill.fields, event });
    };

    return {
      init: async () => step(backfillInit()),
      startBackfill: async ({ startTarget }) =>
        step(backfillStart({ startTarget })),
      backfillPage: async ({ seq }) => step(backfillPage({ seq })),
      liveEvent: async ({ seq }) => step(backfillLiveEvent({ seq })),
      drainDeferred: async () => step(backfillDrain()),
      getState: () => backfill.fields,
    };
  },
);

describe('backfill and live (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/backlink-index/backfill-live.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '858585',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              mode: Schema.String,
              target: Schema.BigInt,
              backfillCursor: Schema.BigInt,
              liveCursor: Schema.BigInt,
              deferred: Schema.BigInt,
              entries: Schema.BigInt,
            }),
          )(raw),
        (spec, impl) =>
          spec.mode === impl.mode &&
          spec.target === impl.target &&
          spec.backfillCursor === impl.backfillCursor &&
          spec.liveCursor === impl.liveCursor &&
          spec.deferred === impl.deferred &&
          spec.entries === impl.entries,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
