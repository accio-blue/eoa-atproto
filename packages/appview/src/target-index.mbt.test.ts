import {
  type TargetIndexFields,
  emptyTargetIndex,
  indexInit,
  indexOffer,
  indexRetract,
  targetIndexStep,
} from './target-index.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the index and its dedupe: `quint run` traces from
 * the spec, replayed against `target-index.ts` and compared to the model -
 * including `IndexAccountingExact` (every offer is exactly one live entry, one
 * duplicate, or one retraction) and `DuplicateNamesPair`.
 */

const TARGET_A = 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a';
const TARGET_B = 'at://did:web:example.com/app.bsky.feed.post/3k2la9x8w1';
const SOURCE_LIKE = 'at://did:plc:genesis/app.bsky.feed.like/3jzsm4zqb2s2b';
const SOURCE_COMMENT = 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2c';

/** The spec's `offer` scenario, as the reference it stands for. */
const offerOf = (scenario: bigint) => ({
  target:
    scenario === 0n || scenario === 1n || scenario === 3n ? TARGET_A : TARGET_B,
  source:
    scenario === 0n || scenario === 1n || scenario === 2n
      ? SOURCE_LIKE
      : SOURCE_COMMENT,
  // The spec's `dupFor`: scenario 1 is the pair already in the index.
  novel: scenario !== 1n,
});

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
    offer: { scenario },
    retract: {},
  },
  () => {
    const index = { fields: emptyTargetIndex() } satisfies {
      fields: TargetIndexFields;
    };
    const step = (event: Parameters<typeof targetIndexStep>[0]['event']) => {
      index.fields = targetIndexStep({ fields: index.fields, event });
    };

    return {
      init: async () => step(indexInit()),
      offer: async ({ scenario }) => step(indexOffer(offerOf(scenario))),
      retract: async () => step(indexRetract()),
      getState: () => index.fields,
    };
  },
);

describe('the target index (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/backlink-index/target-index.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '929292',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              entries: Schema.BigInt,
              observed: Schema.BigInt,
              duplicates: Schema.BigInt,
              removed: Schema.BigInt,
              lastTarget: Schema.String,
              lastSource: Schema.String,
              lastDup: Schema.Boolean,
            }),
          )(raw),
        (spec, impl) =>
          spec.entries === impl.entries &&
          spec.observed === impl.observed &&
          spec.duplicates === impl.duplicates &&
          spec.removed === impl.removed &&
          spec.lastTarget === impl.lastTarget &&
          spec.lastSource === impl.lastSource &&
          spec.lastDup === impl.lastDup,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
