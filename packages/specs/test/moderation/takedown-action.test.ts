import {
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import {
  eventsOf,
  explore,
  simulate,
  stateKey,
} from '@quint-machine/core/testing';
import definitionJson from '../../src/moderation/takedown-action.model.generated.json';

// Spec-only verification for the moderation enforcement-action lifecycle: a
// label is temporary and can expire, a takedown is permanent and can only be
// reversed. The reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const field = (state: QuintModelValue, name: string) => String(state[name]);
const number = (state: QuintModelValue, name: string) =>
  BigInt(state[name] ?? 0n);

describe('moderation takedown action: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('moderation_takedown_action');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'EnforcementValid',
      'StageValid',
      'ActiveHasEnforcement',
      'ExpiredWasTemporary',
      'ReversedHasEnforcement',
      'EnforcementApplied',
      'AppliedNonNegative',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the apply pool expands over the two enforcement kinds
    expect(
      events
        .filter((event) => event._tag === 'apply')
        .map((event) => event['kind'])
        .sort(),
    ).toEqual(['label', 'takedown']);
  });
});

describe('moderation takedown action: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, {
        runs: 1,
        maxSteps: 250,
        seed,
      });
      expect(violations).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 10, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('only a temporary action is ever expired', () => {
    const events = eventsOf(model);
    let state = model.initial;
    for (let index = 0; index < 300; index += 1) {
      const event = events[(index * 13 + 1) % events.length];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      if (field(state, 'stage') === 'expired') {
        expect(state['temporary']).toBe(true);
      }
    }
  });
});

describe('moderation takedown action: boundary behavior', () => {
  it('a temporary label expires and then cannot be reversed', () => {
    let state = model.transition(model.initial, {
      _tag: 'apply',
      kind: 'label',
    });
    expect({
      enforcement: field(state, 'enforcement'),
      stage: field(state, 'stage'),
      temporary: state['temporary'],
      applied: number(state, 'applied'),
    }).toEqual({
      enforcement: 'label',
      stage: 'active',
      temporary: true,
      applied: 1n,
    });

    state = model.transition(state, { _tag: 'expire' });
    expect(field(state, 'stage')).toBe('expired');
    state = model.transition(state, { _tag: 'reverse' });
    expect(field(state, 'stage')).toBe('expired');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a permanent takedown does not expire but can be reversed', () => {
    let state = model.transition(model.initial, {
      _tag: 'apply',
      kind: 'takedown',
    });
    expect(state['temporary']).toBe(false);

    state = model.transition(state, { _tag: 'expire' });
    expect(field(state, 'stage')).toBe('active');
    state = model.transition(state, { _tag: 'reverse' });
    expect({
      enforcement: field(state, 'enforcement'),
      stage: field(state, 'stage'),
      applied: number(state, 'applied'),
    }).toEqual({ enforcement: 'takedown', stage: 'reversed', applied: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        enforcement: 'takedown',
        stage: 'reversed',
        temporary: false,
        applied: 1n,
      }),
    );
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        enforcement: 'none',
        stage: 'expired',
        temporary: false,
        applied: 0n,
      }),
    ).toEqual(['ExpiredWasTemporary', 'EnforcementApplied']);
  });
});
