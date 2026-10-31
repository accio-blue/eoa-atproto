import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import {
  eventsOf,
  explore,
  stateKey,
  verifySpec,
} from '@quint-machine/core/testing';
import definitionJson from '../../src/payments/access-decoupling.model.generated.json';

// Spec-only verification for the payments access-decoupling rule: the payment
// state and the permission grant are independent, so access is a function of
// the grant alone. A billing transition can neither grant nor revoke access.
// The reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const billing = (state: QuintModelValue) => String(state['billing']);
const decision = (state: QuintModelValue) => String(state['accessDecision']);

describe('payments access decoupling: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('payments_access_decoupling');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'BillingValid',
      'DecisionValid',
      'AccessFollowsGrantOnly',
      'PaymentNeverGrantsAccess',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    expect(
      events
        .filter((event) => event._tag === 'setBilling')
        .map((event) => event['value'])
        .sort(),
    ).toEqual(['active', 'grace', 'lapsed', 'none', 'refunded']);
  });
});

describe('payments access decoupling: invariants hold', () => {
  it('no invariant fails on exploration or seeded random walks', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(() =>
        verifySpec(model, {
          maxDepth: 8,
          maxStates: 5000,
          runs: 1,
          maxSteps: 250,
          seed,
        }),
      ).not.toThrow();
    }
  });

  it('reaches a refunded-and-allowed and an active-and-denied state', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    // a lapsed / refunded subscription keeps whatever access was granted
    expect(
      report.reachable(
        (state) =>
          state['billing'] === 'refunded' &&
          state['accessDecision'] === 'allowed',
      ),
    ).toBe(true);
    // a paid subscription is never granted access by paying
    expect(
      report.reachable(
        (state) =>
          state['billing'] === 'active' && state['accessDecision'] === 'denied',
      ),
    ).toBe(true);
  });
});

describe('payments access decoupling: boundaries', () => {
  it('a billing change never revokes a granted access decision', () => {
    let state = run([
      { _tag: 'setAccessGrant', granted: true },
      { _tag: 'evaluateAccess' },
    ]);
    expect(decision(state)).toBe('allowed');

    // the payment state moves to every billing stage; the decision is untouched
    for (const value of ['active', 'grace', 'lapsed', 'refunded', 'none']) {
      state = model.transition(state, { _tag: 'setBilling', value });
      expect({ billing: billing(state), decision: decision(state) }).toEqual({
        billing: value,
        decision: 'allowed',
      });
      expect(violatedInvariants(model, state)).toEqual([]);
    }
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        billing: 'none',
        accessGrant: true,
        accessDecision: 'allowed',
      }),
    );
  });

  it('access follows the grant, not the billing state', () => {
    const denied = run([
      { _tag: 'setBilling', value: 'active' },
      { _tag: 'setAccessGrant', granted: false },
      { _tag: 'evaluateAccess' },
    ]);
    expect({ billing: billing(denied), decision: decision(denied) }).toEqual({
      billing: 'active',
      decision: 'denied',
    });
    expect(violatedInvariants(model, denied)).toEqual([]);

    // a stale decision is cleared when the permission engine changes its grant
    const stale = run([
      { _tag: 'setAccessGrant', granted: true },
      { _tag: 'evaluateAccess' },
      { _tag: 'setAccessGrant', granted: false },
    ]);
    expect(decision(stale)).toBe('none');
    expect(violatedInvariants(model, stale)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    expect(
      violatedInvariants(model, {
        billing: 'zombie',
        accessGrant: true,
        accessDecision: 'allowed',
      }),
    ).toEqual(['BillingValid']);

    expect(
      violatedInvariants(model, {
        billing: 'active',
        accessGrant: false,
        accessDecision: 'allowed',
      }),
    ).toEqual(['AccessFollowsGrantOnly', 'PaymentNeverGrantsAccess']);

    expect(
      violatedInvariants(model, {
        billing: 'refunded',
        accessGrant: true,
        accessDecision: 'denied',
      }),
    ).toEqual(['AccessFollowsGrantOnly']);
  });
});
