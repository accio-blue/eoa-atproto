import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, stateKey } from '@quint-machine/core/testing';
import definitionJson from '../../src/plugin-host/registry_gate.model.generated.json';

// Spec-only verification: the generated model document is the substrate.
// Every invariant is read from the spec (`val` defs) — never hand-listed.
const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

describe('plugin-host / registry escalation gate (signed manifest)', () => {
  it('declares NoEscalationWithoutGate and starts idle/narrow', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NoEscalationWithoutGate',
      'StageValid',
      'SignatureValid',
    ]);
    expect(model.initial).toMatchObject({
      stage: 'idle',
      signature: 'missing',
      width: 'narrow',
    });
    expect(violatedInvariants(model, model.initial)).toEqual([]);
  });

  it('no reachable state violates an invariant', () => {
    const exploration = explore(model, { maxDepth: 12, maxStates: 10_000 });
    expect(exploration.violations).toEqual([]);
    expect(exploration.states.length).toBeGreaterThan(1);
  });

  it('a narrow upgrade takes the fast path to live without the gate', () => {
    const submitted = model.transition(model.initial, {
      _tag: 'submit',
      scope: 'narrow',
    });
    expect(submitted).toMatchObject({
      stage: 'submitted',
      width: 'narrow',
      signature: 'missing',
    });
    const live = model.transition(submitted, { _tag: 'publish' });
    expect(live).toMatchObject({ stage: 'live', width: 'narrow' });
    expect(violatedInvariants(model, live)).toEqual([]);
  });

  it('a widened upgrade is blocked until the gate approves a valid signature', () => {
    let state = model.transition(model.initial, {
      _tag: 'submit',
      scope: 'wide',
    });
    expect(state).toMatchObject({ stage: 'submitted', width: 'wide' });

    // the narrow fast path does not apply to a widened manifest
    expect(model.transition(state, { _tag: 'publish' })).toMatchObject({
      stage: 'submitted',
    });
    // approval before attestation does nothing
    expect(model.transition(state, { _tag: 'approve' })).toMatchObject({
      stage: 'submitted',
    });

    state = model.transition(state, { _tag: 'attest', sig: 'invalid' });
    expect(state).toMatchObject({ stage: 'attested', signature: 'invalid' });
    // an invalid signature blocks the gate
    expect(model.transition(state, { _tag: 'approve' })).toMatchObject({
      stage: 'attested',
    });

    // re-attestation with a valid signature unblocks it
    state = model.transition(state, { _tag: 'attest', sig: 'valid' });
    expect(state).toMatchObject({ stage: 'attested', signature: 'valid' });
    state = model.transition(state, { _tag: 'approve' });
    expect(state).toMatchObject({
      stage: 'live',
      width: 'wide',
      signature: 'valid',
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('rejection abandons the upgrade and allows a fresh submission', () => {
    let state = model.transition(model.initial, {
      _tag: 'submit',
      scope: 'wide',
    });
    state = model.transition(state, { _tag: 'attest', sig: 'valid' });
    state = model.transition(state, { _tag: 'reject' });
    expect(state).toMatchObject({ stage: 'rejected', width: 'wide' });
    state = model.transition(state, { _tag: 'submit', scope: 'narrow' });
    expect(state).toMatchObject({ stage: 'submitted', width: 'narrow' });
  });

  it('a widened live upgrade is reachable; an unsigned one is not', () => {
    const exploration = explore(model, { maxDepth: 12, maxStates: 10_000 });
    const canReach = (
      state: Record<string, string | boolean | bigint>,
    ): boolean =>
      exploration.reachable(
        (candidate) => stateKey(model, candidate) === stateKey(model, state),
      );
    expect(canReach({ stage: 'live', signature: 'valid', width: 'wide' })).toBe(
      true,
    );
    expect(
      canReach({ stage: 'live', signature: 'missing', width: 'wide' }),
    ).toBe(false);
    expect(
      canReach({ stage: 'live', signature: 'invalid', width: 'wide' }),
    ).toBe(false);
  });

  it('NoEscalationWithoutGate has teeth on synthetic bad states', () => {
    expect(
      violatedInvariants(model, {
        stage: 'live',
        signature: 'invalid',
        width: 'wide',
      }),
    ).toEqual(['NoEscalationWithoutGate']);

    expect(
      violatedInvariants(model, {
        stage: 'live',
        signature: 'missing',
        width: 'wide',
      }),
    ).toEqual(['NoEscalationWithoutGate']);

    expect(
      violatedInvariants(model, {
        stage: 'zombie',
        signature: 'rotten',
        width: 'narrow',
      }),
    ).toEqual(['StageValid', 'SignatureValid']);
  });
});
