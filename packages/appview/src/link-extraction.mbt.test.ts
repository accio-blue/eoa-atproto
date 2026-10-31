import {
  type LinkExtractionFields,
  extractionInit,
  extractionObserve,
  extractionPause,
  extractionStart,
  extractionStep,
  idleExtraction,
} from './link-extraction.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the extractor: `quint run` traces from the spec,
 * replayed against `link-extraction.ts` and compared to the model - including
 * `IngestExact` (the cursor is exactly the records consumed) and `IndexExact`
 * (one index entry per extracted reference).
 *
 * The spec's scenario is a model shorthand; this is where it becomes the record
 * it stands for, using the spec's own sample targets and sources.
 */

const TARGET_A = 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a';
const TARGET_B = 'at://did:web:example.com/app.bsky.feed.post/3k2la9x8w1';
const SOURCE_LIKE = 'at://did:plc:genesis/app.bsky.feed.like/3jzsm4zqb2s2b';
const SOURCE_COMMENT = 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2c';

/** The spec's scenarios, as the records they stand for. */
const RECORDS: Record<string, { source: string; refs: readonly string[] }> = {
  '0': { source: SOURCE_LIKE, refs: [] },
  '1': { source: SOURCE_LIKE, refs: [TARGET_A] },
  '2': { source: SOURCE_LIKE, refs: [TARGET_A, TARGET_B] },
  '3': { source: SOURCE_COMMENT, refs: [TARGET_B] },
};

/** The spec's `observe` scenario, as the record it stands for. */
const observeOf = (scenario: bigint) =>
  RECORDS[scenario.toString()] ?? { source: SOURCE_LIKE, refs: [] };

const scenario: StandardSchemaV1<unknown, bigint> = {
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
    observe: { scenario },
    pause: {},
  },
  () => {
    const extraction = { fields: idleExtraction() } satisfies {
      fields: LinkExtractionFields;
    };
    const step = (event: Parameters<typeof extractionStep>[0]['event']) => {
      extraction.fields = extractionStep({ fields: extraction.fields, event });
    };

    return {
      init: async () => step(extractionInit()),
      start: async () => step(extractionStart()),
      observe: async ({ scenario }) =>
        step(extractionObserve(observeOf(scenario))),
      pause: async () => step(extractionPause()),
      getState: () => extraction.fields,
    };
  },
);

describe('link extraction (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/backlink-index/link-extraction.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '919191',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              mode: Schema.String,
              cursor: Schema.BigInt,
              observed: Schema.BigInt,
              extracted: Schema.BigInt,
              indexed: Schema.BigInt,
              lastTarget: Schema.String,
              lastSource: Schema.String,
            }),
          )(raw),
        (spec, impl) =>
          spec.mode === impl.mode &&
          spec.cursor === impl.cursor &&
          spec.observed === impl.observed &&
          spec.extracted === impl.extracted &&
          spec.indexed === impl.indexed &&
          spec.lastTarget === impl.lastTarget &&
          spec.lastSource === impl.lastSource,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
