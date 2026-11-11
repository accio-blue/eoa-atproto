import {
  FRESH_PROOF,
  type NonceFields,
  REPLAYED_JTI,
  STALE_NONCE,
  STALE_NONCE_AND_REPLAYED_JTI,
  acceptsProof,
  freshNonceState,
  nonceChallenge,
  nonceInit,
  nonceRotate,
  nonceStep,
  nonceSubmit,
} from './dpop-nonce.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the DPoP nonce / replay machine: `quint run` produces
 * traces, and every `submit`/`rotate`/`challenge` is replayed against
 * `dpop-nonce.ts` and compared to the model's state.
 *
 * The spec's `scenario` selector is decoded into the proof's two facts below, so
 * the same decisions the provider makes in M2 are the ones under test.
 */

const scenarioPick: StandardSchemaV1<unknown, bigint> = {
  '~standard': {
    version: 1,
    vendor: 'oauth',
    validate: (value) =>
      typeof value === 'bigint'
        ? { value }
        : {
            issues: [{ message: `expected a Quint int, got ${String(value)}` }],
          },
  },
};

const driver = defineDriver(
  {
    init: {},
    submit: { scenario: scenarioPick },
    rotate: {},
    challenge: {},
  },
  () => {
    const server = { fields: freshNonceState() } satisfies {
      fields: NonceFields;
    };
    const step = (event: Parameters<typeof nonceStep>[0]['event']) => {
      server.fields = nonceStep({ fields: server.fields, event });
    };

    return {
      init: async () => step(nonceInit()),
      submit: async ({ scenario }) => step(nonceSubmit({ scenario })),
      rotate: async () => step(nonceRotate()),
      challenge: async () => step(nonceChallenge()),
      getState: () => server.fields,
    };
  },
);

describe('oauth DPoP nonce (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL('../../specs/specs/oauth/dpop-nonce.qnt', import.meta.url)
        .pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '4815162342',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              phase: Schema.String,
              nextNonce: Schema.BigInt,
              usedNonce: Schema.BigInt,
              nextJti: Schema.BigInt,
              lastJti: Schema.BigInt,
              presentedNonce: Schema.BigInt,
              presentedJti: Schema.BigInt,
              nonceOk: Schema.Boolean,
              jtiOk: Schema.Boolean,
            }),
          )(raw),
        (spec, impl) =>
          spec.phase === impl.phase &&
          spec.nextNonce === impl.nextNonce &&
          spec.usedNonce === impl.usedNonce &&
          spec.nextJti === impl.nextJti &&
          spec.lastJti === impl.lastJti &&
          spec.presentedNonce === impl.presentedNonce &&
          spec.presentedJti === impl.presentedJti &&
          spec.nonceOk === impl.nonceOk &&
          spec.jtiOk === impl.jtiOk,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 180_000);
});

describe('the decision the provider actually makes (acceptsProof)', () => {
  it('accepts a fresh proof and consumes both the nonce and the jti', () => {
    const server = freshNonceState();
    expect(
      acceptsProof({
        state: server,
        nonce: server.nextNonce,
        jti: server.nextJti,
      }),
    ).toBe(true);

    const accepted = nonceStep({
      fields: server,
      event: nonceSubmit({ scenario: FRESH_PROOF }),
    });
    expect(accepted.phase).toBe('accepted');
    expect(accepted.usedNonce).toBe(server.nextNonce);
    expect(accepted.lastJti).toBe(server.nextJti);
  });

  it('rejects a replayed jti, a stale nonce, and both together', () => {
    const server = freshNonceState();
    // both facts are now fresh only once; the watermark moves on acceptance
    const accepted = nonceStep({
      fields: server,
      event: nonceSubmit({ scenario: FRESH_PROOF }),
    });

    expect(
      acceptsProof({
        state: accepted,
        nonce: accepted.nextNonce,
        jti: accepted.lastJti,
      }),
    ).toBe(false);
    expect(
      acceptsProof({
        state: accepted,
        nonce: accepted.usedNonce,
        jti: accepted.nextJti,
      }),
    ).toBe(false);
    expect(
      acceptsProof({
        state: accepted,
        nonce: accepted.usedNonce,
        jti: accepted.lastJti,
      }),
    ).toBe(false);
  });

  it('the scenario labels mean what the spec says they mean', () => {
    const server = freshNonceState();
    const stateOf = (scenario: bigint) =>
      nonceStep({ fields: server, event: nonceSubmit({ scenario }) });

    expect(stateOf(FRESH_PROOF).phase).toBe('accepted');
    expect(stateOf(STALE_NONCE).phase).toBe('rejected');
    expect(stateOf(REPLAYED_JTI).phase).toBe('rejected');
    expect(stateOf(STALE_NONCE_AND_REPLAYED_JTI).phase).toBe('rejected');

    // a rejection names the check that failed
    expect(stateOf(STALE_NONCE).nonceOk).toBe(false);
    expect(stateOf(STALE_NONCE).jtiOk).toBe(true);
    expect(stateOf(REPLAYED_JTI).nonceOk).toBe(true);
    expect(stateOf(REPLAYED_JTI).jtiOk).toBe(false);
  });

  it('a stale-nonce rejection earns a fresh nonce; an accepted one already rotated', () => {
    const server = freshNonceState();
    const rejected = nonceStep({
      fields: server,
      event: nonceSubmit({ scenario: STALE_NONCE }),
    });
    const challenged = nonceStep({ fields: rejected, event: nonceChallenge() });
    expect(challenged.nextNonce).toBe(server.nextNonce + 1n);

    // and rotate hands one out unconditionally
    expect(nonceStep({ fields: server, event: nonceRotate() }).nextNonce).toBe(
      server.nextNonce + 1n,
    );
  });
});
