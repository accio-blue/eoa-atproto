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
  simulate,
  stateKey,
} from '@quint-machine/core/testing';
import definitionJson from '../../src/labeler/labeler-subscription.model.generated.json';

// Spec-only verification of the client's labeler subscription: a label is shown
// only from an active subscription to the labeler whose service record declares
// that value, and only while unexpired. Visibility is the shared fail-closed
// grant oracle (`shared/auth.qnt`), so absence, revocation, a foreign labeler,
// an undeclared value, or expiry all hide the label.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const text = (state: QuintModelValue, field: string) => String(state[field]);
const flag = (state: QuintModelValue, field: string) => Boolean(state[field]);

describe('labeler subscription: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('labeler_subscription');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'SubscriptionValid',
      'VisibleIsOracle',
      'VisibleRequiresActive',
      'VisibleRequiresMatch',
      'VisibleRequiresDeclared',
      'NotVisibleWhenExpired',
      'RevokedNeverVisible',
    ]);
  });

  it('the resolve pool expands over all three label origins', () => {
    const events = eventsOf(model);
    expect(
      events
        .filter((event) => event._tag === 'resolve')
        .map((event) => event['origin'])
        .sort(),
    ).toEqual(['foreign', 'listed', 'unlisted']);
  });
});

describe('labeler subscription: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 250, seed });
      expect(violations).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 10, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.reachable((state) => state['visible'] === true)).toBe(true);
    expect(
      report.reachable((state) => state['subscription'] === 'revoked'),
    ).toBe(true);
  });
});

describe('labeler subscription: boundary behavior', () => {
  it('only a listed value from an active subscription is visible', () => {
    let state = run([
      { _tag: 'subscribe' },
      { _tag: 'resolve', origin: 'listed' },
    ]);
    expect({
      subscription: text(state, 'subscription'),
      labelerMatch: flag(state, 'labelerMatch'),
      declared: flag(state, 'declared'),
      visible: flag(state, 'visible'),
    }).toEqual({
      subscription: 'active',
      labelerMatch: true,
      declared: true,
      visible: true,
    });
    expect(violatedInvariants(model, state)).toEqual([]);

    // the same subscription: an undeclared value and a foreign labeler hide
    state = model.transition(state, { _tag: 'resolve', origin: 'unlisted' });
    expect(flag(state, 'visible')).toBe(false);
    state = model.transition(state, { _tag: 'resolve', origin: 'foreign' });
    expect({
      labelerMatch: flag(state, 'labelerMatch'),
      visible: flag(state, 'visible'),
    }).toEqual({ labelerMatch: false, visible: false });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('unsubscribing hides a label even from the subscribed labeler', () => {
    let state = run([
      { _tag: 'subscribe' },
      { _tag: 'resolve', origin: 'listed' },
    ]);
    expect(flag(state, 'visible')).toBe(true);

    state = model.transition(state, { _tag: 'unsubscribe' });
    expect({
      subscription: text(state, 'subscription'),
      visible: flag(state, 'visible'),
    }).toEqual({ subscription: 'revoked', visible: false });

    // a subsequent listed label cannot resurrect visibility
    state = model.transition(state, { _tag: 'resolve', origin: 'listed' });
    expect({ visible: flag(state, 'visible') }).toEqual({ visible: false });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('an expired label is never visible', () => {
    let state = run([
      { _tag: 'subscribe' },
      { _tag: 'resolve', origin: 'listed' },
    ]);
    state = model.transition(state, { _tag: 'expire' });
    expect({
      expired: flag(state, 'expired'),
      visible: flag(state, 'visible'),
    }).toEqual({ expired: true, visible: false });
    expect(violatedInvariants(model, state)).toEqual([]);
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        subscription: 'active',
        labelerMatch: true,
        declared: true,
        expired: true,
        visible: false,
      }),
    );
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        subscription: 'active',
        labelerMatch: true,
        declared: true,
        expired: false,
        visible: true,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        subscription: 'revoked',
        labelerMatch: true,
        declared: true,
        expired: false,
        visible: true,
      }),
    ).toEqual([
      'VisibleIsOracle',
      'VisibleRequiresActive',
      'RevokedNeverVisible',
    ]);

    expect(
      violatedInvariants(model, {
        subscription: 'active',
        labelerMatch: true,
        declared: true,
        expired: true,
        visible: true,
      }),
    ).toEqual(['VisibleIsOracle', 'NotVisibleWhenExpired']);
  });
});
