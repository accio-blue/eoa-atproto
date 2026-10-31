import {
  type CursorFields,
  cursorBackfill,
  cursorCommit,
  cursorDegrade,
  cursorInit,
  cursorOpen,
  cursorRetry,
  cursorStep,
  cursorSubscribe,
  idleCursor,
} from './subscription-cursor.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the subscription cursor: `quint run` produces traces
 * from the spec, and every step is replayed against `subscription-cursor.ts` and
 * compared to the model's state - including `NoGapSkipped`, which is the whole
 * point of the cursor discipline.
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
    subscribe: {},
    open: {},
    commit: { delta: bigint },
    backfill: {},
    degrade: {},
    retry: {},
  },
  () => {
    const subscription = { fields: idleCursor() } satisfies {
      fields: CursorFields;
    };
    const step = (event: Parameters<typeof cursorStep>[0]['event']) => {
      subscription.fields = cursorStep({ fields: subscription.fields, event });
    };

    return {
      init: async () => step(cursorInit()),
      subscribe: async () => step(cursorSubscribe()),
      open: async () => step(cursorOpen()),
      commit: async ({ delta }) => step(cursorCommit({ delta })),
      backfill: async () => step(cursorBackfill()),
      degrade: async () => step(cursorDegrade()),
      retry: async () => step(cursorRetry()),
      getState: () => subscription.fields,
    };
  },
);

describe('subscription cursor (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/relay/subscription-cursor.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '616161',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              status: Schema.String,
              cursor: Schema.BigInt,
              resume: Schema.BigInt,
              attempts: Schema.BigInt,
            }),
          )(raw),
        (spec, impl) =>
          spec.status === impl.status &&
          spec.cursor === impl.cursor &&
          spec.resume === impl.resume &&
          spec.attempts === impl.attempts,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
