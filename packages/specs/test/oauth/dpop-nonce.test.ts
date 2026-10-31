import {
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, stateKey } from '@quint-machine/core/testing';
import { Schema } from 'effect';
import definitionJson from '../../src/oauth/dpop-nonce.model.generated.json';

// Spec-only verification for specs/oauth/dpop-nonce.qnt: the DPoP nonce /
// replay machine. The shared harness derives the event alphabet from the
// spec's own pools and checks every declared invariant after every step.

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

const initial = model.initial;

describe('oauth dpop-nonce (spec-only)', () => {
  it('declares every invariant the spec owns', () => {
    expect(invariants).toEqual([
      'NoReplay',
      'NonceFresh',
      'AcceptedImpliesChecks',
      'RejectedImpliesReason',
    ]);
  });

  it('invariants have teeth on hand-built bad states', () => {
    expect(
      violatedInvariants(model, {
        phase: 'accepted',
        nextNonce: 2n,
        usedNonce: 2n,
        nextJti: 2n,
        lastJti: 2n,
        presentedNonce: 2n,
        presentedJti: 2n,
        nonceOk: false,
        jtiOk: false,
      }),
    ).toEqual(['NoReplay', 'NonceFresh', 'AcceptedImpliesChecks']);

    expect(
      violatedInvariants(model, {
        ...initial,
        phase: 'rejected',
        nonceOk: true,
        jtiOk: true,
      }),
    ).toEqual(['RejectedImpliesReason']);
  });

  it('accepts a fresh proof and rotates nonce + jti watermark', () => {
    expect(initial).toMatchObject({
      phase: 'ready',
      nextNonce: 1n,
      usedNonce: 0n,
      nextJti: 1n,
      lastJti: 0n,
    });

    const accepted = step(initial, { _tag: 'submit', scenario: 0n });
    expect(accepted).toMatchObject({
      phase: 'accepted',
      nextNonce: 2n,
      usedNonce: 1n,
      nextJti: 2n,
      lastJti: 1n,
      nonceOk: true,
      jtiOk: true,
    });
  });

  it('rejects a replayed jti and leaves the watermark untouched', () => {
    const accepted = step(initial, { _tag: 'submit', scenario: 0n });
    const replay = step(accepted, { _tag: 'submit', scenario: 2n });
    expect(replay).toMatchObject({
      phase: 'rejected',
      nonceOk: true,
      jtiOk: false,
      nextNonce: 2n,
      usedNonce: 1n,
      nextJti: 2n,
      lastJti: 1n,
    });

    // and again: a replay never advances any watermark
    const again = step(replay, { _tag: 'submit', scenario: 2n });
    expect(again).toMatchObject({
      phase: 'rejected',
      nextNonce: 2n,
      usedNonce: 1n,
      nextJti: 2n,
      lastJti: 1n,
    });
  });

  it('rejects a stale nonce and answers with a fresh one', () => {
    const stale = step(initial, { _tag: 'submit', scenario: 1n });
    expect(stale).toMatchObject({
      phase: 'rejected',
      nonceOk: false,
      jtiOk: true,
      nextNonce: 1n,
      usedNonce: 0n,
    });

    const challenged = step(stale, { _tag: 'challenge' });
    expect(challenged).toMatchObject({
      phase: 'rejected',
      nextNonce: 2n,
      usedNonce: 0n,
    });

    // a challenge after an accepted submission must NOT rotate
    const accepted = step(initial, { _tag: 'submit', scenario: 0n });
    const noChallenge = step(accepted, { _tag: 'challenge' });
    expect(noChallenge).toMatchObject({ nextNonce: 2n });
  });

  it('rejects a proof that is both stale and already seen', () => {
    const rejected = step(initial, { _tag: 'submit', scenario: 3n });
    expect(rejected).toMatchObject({
      phase: 'rejected',
      nonceOk: false,
      jtiOk: false,
      nextNonce: 1n,
      nextJti: 1n,
    });
  });

  it('rotate always moves the expected nonce past the consumed one', () => {
    const accepted = step(initial, { _tag: 'submit', scenario: 0n });
    const rotated = step(accepted, { _tag: 'rotate' });
    expect(rotated).toMatchObject({
      phase: 'accepted',
      nextNonce: 3n,
      usedNonce: 1n,
    });
  });

  it('exposes a typed event schema for the scenario pool', () => {
    const schema = model.eventSchemas['submit'];
    if (schema === undefined) {
      throw new Error('no event schema for submit');
    }
    const decode = Schema.decodeUnknownSync(
      schema as Schema.Codec<Record<string, unknown>>,
    );
    expect(decode({ _tag: 'submit', scenario: 0n })).toEqual({
      _tag: 'submit',
      scenario: 0n,
    });
    expect(() => decode({ _tag: 'submit', scenario: '0' })).toThrow();
  });

  it('no reachable state violates an invariant (bounded exploration)', () => {
    const report = explore(model, { maxDepth: 5, maxStates: 20_000 });
    expect(report.violations).toEqual([]);
    const distinct = new Set(
      report.states.map((state) => stateKey(model, state)),
    );
    expect(distinct.size).toBeGreaterThan(20);
  });
});
