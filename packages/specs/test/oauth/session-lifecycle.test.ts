import {
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, stateKey } from '@quint-machine/core/testing';
import { Schema } from 'effect';
import definitionJson from '../../src/oauth/session-lifecycle.model.generated.json';

// Spec-only verification for specs/oauth/session-lifecycle.qnt.
//
// There is no Effect runtime for the OAuth provider yet, so the spec's
// reference model is the system under test: the shared harness derives the
// event alphabet from the spec's own pools, steps `transition`, and checks
// every declared invariant after every step.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const invariants = model.invariants.map((invariant) => invariant.name);

const step = (
  state: QuintModelValue,
  event: Record<string, unknown>,
): QuintModelValue => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

describe('oauth session-lifecycle (spec-only)', () => {
  it('declares every invariant the spec owns', () => {
    expect(invariants).toEqual([
      'RevokedCannotRefresh',
      'NoTokenWithoutPkce',
      'NoCodeWithoutPar',
      'CodeUsedImpliesIssued',
      'RefreshWithinAccess',
      'StageValid',
    ]);
  });

  it('invariants have teeth on hand-built bad states', () => {
    expect(
      violatedInvariants(model, {
        stage: 'zombie',
        parPushed: false,
        codeIssued: false,
        codeUsed: true,
        pkceVerified: false,
        accessGeneration: 1n,
        refreshGeneration: 2n,
        refreshUsable: true,
        revoked: true,
      }),
    ).toEqual([
      'RevokedCannotRefresh',
      'NoTokenWithoutPkce',
      'CodeUsedImpliesIssued',
      'RefreshWithinAccess',
      'StageValid',
    ]);
  });

  it('runs the happy path PAR -> authorize -> token -> refresh', () => {
    let state = step(model.initial, { _tag: 'push_request' });
    expect(state).toMatchObject({ stage: 'par_pushed', parPushed: true });

    state = step(state, { _tag: 'authorize' });
    expect(state).toMatchObject({
      stage: 'authorized',
      codeIssued: true,
      codeUsed: false,
    });

    state = step(state, { _tag: 'exchange', pkce: true });
    expect(state).toMatchObject({
      stage: 'issued',
      pkceVerified: true,
      accessGeneration: 1n,
      refreshGeneration: 1n,
      refreshUsable: true,
    });

    state = step(state, { _tag: 'refresh' });
    expect(state).toMatchObject({
      stage: 'refreshed',
      accessGeneration: 2n,
      refreshGeneration: 2n,
    });
  });

  it('PKCE mismatch fails closed: no tokens, code burned, no retry', () => {
    let state = step(model.initial, { _tag: 'push_request' });
    state = step(state, { _tag: 'authorize' });

    const rejected = step(state, { _tag: 'exchange', pkce: false });
    expect(rejected).toMatchObject({
      stage: 'authorized',
      pkceVerified: false,
      accessGeneration: 0n,
      refreshGeneration: 0n,
      refreshUsable: false,
      codeUsed: true,
    });

    // a second exchange cannot succeed — the code is single-use
    const retried = step(rejected, { _tag: 'exchange', pkce: true });
    expect(retried).toMatchObject({
      stage: 'authorized',
      accessGeneration: 0n,
      pkceVerified: false,
    });
  });

  it('an expired refresh token cannot refresh', () => {
    const issued = [
      { _tag: 'push_request' },
      { _tag: 'authorize' },
      { _tag: 'exchange', pkce: true },
      { _tag: 'expire_refresh' },
    ].reduce(step, model.initial);

    const after = step(issued, { _tag: 'refresh' });
    expect(after).toMatchObject({
      accessGeneration: 1n,
      refreshGeneration: 1n,
      refreshUsable: false,
    });
  });

  it('a revoked token cannot refresh and the grant stays revoked', () => {
    const revoked = [
      { _tag: 'push_request' },
      { _tag: 'authorize' },
      { _tag: 'exchange', pkce: true },
      { _tag: 'revoke' },
    ].reduce(step, model.initial);
    expect(revoked).toMatchObject({ revoked: true, refreshUsable: false });

    const after = step(revoked, { _tag: 'refresh' });
    expect(after).toMatchObject({
      stage: 'revoked',
      revoked: true,
      accessGeneration: 1n,
      refreshGeneration: 1n,
    });
  });

  it('denial kills the grant before any token exists', () => {
    const pushed = step(model.initial, { _tag: 'push_request' });
    const denied = step(pushed, { _tag: 'deny' });
    expect(denied).toMatchObject({
      stage: 'revoked',
      revoked: true,
      accessGeneration: 0n,
      refreshUsable: false,
    });
  });

  it('a revoked grant cannot exchange an unused code', () => {
    const revoked = [
      { _tag: 'push_request' },
      { _tag: 'authorize' },
      { _tag: 'revoke' },
    ].reduce(step, model.initial);
    expect(revoked).toMatchObject({
      codeIssued: true,
      codeUsed: false,
      revoked: true,
      refreshUsable: false,
    });

    const after = step(revoked, { _tag: 'exchange', pkce: true });
    expect(after).toMatchObject({
      revoked: true,
      accessGeneration: 0n,
      refreshUsable: false,
      pkceVerified: false,
    });
  });

  it('exposes a typed event schema for the exchange PKCE pool', () => {
    const schema = model.eventSchemas['exchange'];
    if (schema === undefined) {
      throw new Error('no event schema for exchange');
    }
    const decode = Schema.decodeUnknownSync(
      schema as Schema.Codec<Record<string, unknown>>,
    );
    expect(decode({ _tag: 'exchange', pkce: true })).toEqual({
      _tag: 'exchange',
      pkce: true,
    });
    expect(() => decode({ _tag: 'exchange', pkce: 'yes' })).toThrow();
  });

  it('no reachable state violates an invariant (bounded exploration)', () => {
    const report = explore(model, { maxDepth: 5, maxStates: 20_000 });
    expect(report.violations).toEqual([]);
    const distinct = new Set(
      report.states.map((state) => stateKey(model, state)),
    );
    expect(distinct.size).toBeGreaterThan(10);
  });
});
