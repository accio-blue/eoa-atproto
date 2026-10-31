import {
  type FilterFields,
  filterInit,
  filterPause,
  filterRecord,
  filterResume,
  filterStart,
  filterStep,
  filterStop,
  idleFilter,
} from './jetstream-filter.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the Jetstream projection: `quint run` traces from the
 * spec, replayed against `jetstream-filter.ts` and compared to the model -
 * including `AccountingExact`, which is the property the projection exists for.
 */

const collection: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'sync',
    validate: (value) =>
      typeof value === 'string'
        ? { value }
        : { issues: [{ message: `expected string, got ${typeof value}` }] },
  },
};

const driver = defineDriver(
  {
    init: {},
    start: {},
    record: { collection },
    pause: {},
    resume: {},
    stop: {},
  },
  () => {
    const projection = { fields: idleFilter() } satisfies {
      fields: FilterFields;
    };
    const step = (event: Parameters<typeof filterStep>[0]['event']) => {
      projection.fields = filterStep({ fields: projection.fields, event });
    };

    return {
      init: async () => step(filterInit()),
      start: async () => step(filterStart()),
      record: async ({ collection }) => step(filterRecord({ collection })),
      pause: async () => step(filterPause()),
      resume: async () => step(filterResume()),
      stop: async () => step(filterStop()),
      getState: () => projection.fields,
    };
  },
);

describe('jetstream filter (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/relay/jetstream-filter.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '717171',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              status: Schema.String,
              seen: Schema.BigInt,
              matched: Schema.BigInt,
              dropped: Schema.BigInt,
            }),
          )(raw),
        (spec, impl) =>
          spec.status === impl.status &&
          spec.seen === impl.seen &&
          spec.matched === impl.matched &&
          spec.dropped === impl.dropped,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
