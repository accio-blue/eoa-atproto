import {
  type SessionFields,
  newSession,
  sessionAuthorize,
  sessionDeny,
  sessionExchange,
  sessionExpireRefresh,
  sessionInit,
  sessionPushRequest,
  sessionRefresh,
  sessionRevoke,
  sessionStep,
} from './session-lifecycle.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the OAuth session lifecycle: `quint run` produces
 * traces from the spec, and every step is replayed against `session-lifecycle.ts`
 * and compared to the model's state.
 *
 * `packages/specs/test/oauth/session-lifecycle.test.ts` verifies the model on its
 * own; this is the other half — the model is what the runtime must agree with.
 */

const booleanPick: StandardSchemaV1<unknown, boolean> = {
  '~standard': {
    version: 1,
    vendor: 'oauth',
    validate: (value) =>
      typeof value === 'boolean'
        ? { value }
        : {
            issues: [{ message: `expected a boolean, got ${String(value)}` }],
          },
  },
};

const driver = defineDriver(
  {
    init: {},
    push_request: {},
    authorize: {},
    deny: {},
    exchange: { pkce: booleanPick },
    refresh: {},
    expire_refresh: {},
    revoke: {},
  },
  () => {
    // A cell, not a `let`: the driver is called once per trace and the actions
    // below mutate the field record it holds.
    const grant = { fields: newSession() } satisfies { fields: SessionFields };
    const step = (event: Parameters<typeof sessionStep>[0]['event']) => {
      grant.fields = sessionStep({ fields: grant.fields, event });
    };

    return {
      init: async () => step(sessionInit()),
      push_request: async () => step(sessionPushRequest()),
      authorize: async () => step(sessionAuthorize()),
      deny: async () => step(sessionDeny()),
      exchange: async ({ pkce }) => step(sessionExchange({ pkce })),
      refresh: async () => step(sessionRefresh()),
      expire_refresh: async () => step(sessionExpireRefresh()),
      revoke: async () => step(sessionRevoke()),
      getState: () => grant.fields,
    };
  },
);

describe('oauth session lifecycle (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/oauth/session-lifecycle.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '845329',
      driver,
      stateCheck: stateCheck(
        // The spec's state, parsed rather than assumed: it arrives from ITF.
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              stage: Schema.String,
              parPushed: Schema.Boolean,
              codeIssued: Schema.Boolean,
              codeUsed: Schema.Boolean,
              pkceVerified: Schema.Boolean,
              accessGeneration: Schema.BigInt,
              refreshGeneration: Schema.BigInt,
              refreshUsable: Schema.Boolean,
              revoked: Schema.Boolean,
            }),
          )(raw),
        (spec, impl) =>
          spec.stage === impl.stage &&
          spec.parPushed === impl.parPushed &&
          spec.codeIssued === impl.codeIssued &&
          spec.codeUsed === impl.codeUsed &&
          spec.pkceVerified === impl.pkceVerified &&
          spec.accessGeneration === impl.accessGeneration &&
          spec.refreshGeneration === impl.refreshGeneration &&
          spec.refreshUsable === impl.refreshUsable &&
          spec.revoked === impl.revoked,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});

describe('the fail-closed rules the traces cannot always reach', () => {
  it('burns the code on a PKCE mismatch without minting anything', () => {
    const authorized = sessionStep({
      fields: newSession(),
      event: sessionPushRequest(),
    });
    const withCode = sessionStep({
      fields: authorized,
      event: sessionAuthorize(),
    });

    const afterMismatch = sessionStep({
      fields: withCode,
      event: sessionExchange({ pkce: false }),
    });

    expect(afterMismatch.codeUsed).toBe(true);
    expect(afterMismatch.pkceVerified).toBe(false);
    expect(afterMismatch.accessGeneration).toBe(0n);
    expect(afterMismatch.refreshGeneration).toBe(0n);
    expect(afterMismatch.stage).toBe('authorized');

    // and the burned code cannot be retried with the correct verifier
    const afterRetry = sessionStep({
      fields: afterMismatch,
      event: sessionExchange({ pkce: true }),
    });
    expect(afterRetry.accessGeneration).toBe(0n);
  });

  it('a revoked grant can neither exchange nor refresh', () => {
    const withCode = sessionStep({
      fields: sessionStep({
        fields: newSession(),
        event: sessionPushRequest(),
      }),
      event: sessionAuthorize(),
    });
    const revoked = sessionStep({ fields: withCode, event: sessionRevoke() });

    const exchanged = sessionStep({
      fields: revoked,
      event: sessionExchange({ pkce: true }),
    });
    expect(exchanged.accessGeneration).toBe(0n);

    const refreshed = sessionStep({ fields: revoked, event: sessionRefresh() });
    expect(refreshed.refreshGeneration).toBe(0n);
  });
});
