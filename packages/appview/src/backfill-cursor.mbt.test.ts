import {
  type BackfillCursorFields,
  backfillCursorStep,
  cursorDrain,
  cursorInit,
  cursorLive,
  cursorPage,
  cursorStart,
  idleBackfillCursor,
} from './backfill-cursor.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the AppView backfill/live cursor: `quint run`
 * traces from the spec, replayed against `backfill-cursor.ts` and compared to
 * the model - including `NoDoubleApply` (the live stream never applies a
 * sequence the backfill also covers) and `HandoffConsistent`.
 *
 * The spec's nondeterministic `seq`/`startTarget` are domain values the driver
 * passes straight through; this spec has no `def` deriving a value from a
 * `nondet`, so no scenario-to-domain mapping is needed.
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
    backfillEvent: { seq: bigint },
    liveEvent: { seq: bigint },
    drainDeferred: {},
  },
  () => {
    const cursor = { fields: idleBackfillCursor() } satisfies {
      fields: BackfillCursorFields;
    };
    const step = (event: Parameters<typeof backfillCursorStep>[0]['event']) => {
      cursor.fields = backfillCursorStep({ fields: cursor.fields, event });
    };

    return {
      init: async () => step(cursorInit()),
      startBackfill: async ({ startTarget }) =>
        step(cursorStart({ startTarget })),
      backfillEvent: async ({ seq }) => step(cursorPage({ seq })),
      liveEvent: async ({ seq }) => step(cursorLive({ seq })),
      drainDeferred: async () => step(cursorDrain()),
      getState: () => cursor.fields,
    };
  },
);

describe('appview backfill cursor (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/appview/backfill-cursor.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '636363',
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
            }),
          )(raw),
        (spec, impl) =>
          spec.mode === impl.mode &&
          spec.target === impl.target &&
          spec.backfillCursor === impl.backfillCursor &&
          spec.liveCursor === impl.liveCursor &&
          spec.deferred === impl.deferred,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
