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
import definitionJson from '../../src/labeler/claim-projection.model.generated.json';

// Spec-only verification of the claim -> label projection: a claim is truth, a
// label is a view of it. Filing or upholding a claim projects a visible label;
// dismissing or withdrawing projects a negation; idle projects nothing. The
// label is exactly the projection of the claim - never authored independently.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const text = (state: QuintModelValue, field: string) => String(state[field]);
const count = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('labeler claim projection: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('labeler_claim_projection');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'ClaimValid',
      'LabelValid',
      'LabelIsView',
      'VisibleBackedByClaim',
      'NegationDeniesClaim',
      'NoLabelWithoutClaim',
      'RevisionNonNegative',
    ]);
  });

  it('derives a bare event per action from the step relation', () => {
    const events = eventsOf(model);
    expect(events).toEqual([
      { _tag: 'file' },
      { _tag: 'uphold' },
      { _tag: 'dismiss' },
      { _tag: 'withdraw' },
      { _tag: 'reproject' },
    ]);
  });
});

describe('labeler claim projection: invariants under exploration', () => {
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
    expect(report.reachable((state) => state['label'] === 'visible')).toBe(
      true,
    );
    expect(report.reachable((state) => state['label'] === 'negated')).toBe(
      true,
    );
  });
});

describe('labeler claim projection: boundary behavior', () => {
  it('a filed claim projects a visible label, an upheld one keeps it', () => {
    let state = run([{ _tag: 'file' }]);
    expect({
      claim: text(state, 'claim'),
      label: text(state, 'label'),
      revision: count(state, 'revision'),
    }).toEqual({ claim: 'filed', label: 'visible', revision: 1n });

    state = model.transition(state, { _tag: 'uphold' });
    expect({
      claim: text(state, 'claim'),
      label: text(state, 'label'),
      revision: count(state, 'revision'),
    }).toEqual({ claim: 'upheld', label: 'visible', revision: 2n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('dismissing a confirmed claim retracts the truth into a negation', () => {
    let state = run([
      { _tag: 'file' },
      { _tag: 'uphold' },
      { _tag: 'dismiss' },
    ]);
    expect({
      claim: text(state, 'claim'),
      label: text(state, 'label'),
      revision: count(state, 'revision'),
    }).toEqual({ claim: 'dismissed', label: 'negated', revision: 3n });
    expect(violatedInvariants(model, state)).toEqual([]);

    // re-projecting an already-resolved claim keeps the negation (idempotent)
    state = model.transition(state, { _tag: 'reproject' });
    expect({ label: text(state, 'label') }).toEqual({ label: 'negated' });
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        claim: 'dismissed',
        label: 'negated',
        revision: 3n,
      }),
    );
  });

  it('a withdrawn claim projects a negation from the filed state', () => {
    const state = run([{ _tag: 'file' }, { _tag: 'withdraw' }]);
    expect({
      claim: text(state, 'claim'),
      label: text(state, 'label'),
      revision: count(state, 'revision'),
    }).toEqual({ claim: 'withdrawn', label: 'negated', revision: 2n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a view that outruns the claim', () => {
    expect(
      violatedInvariants(model, {
        claim: 'filed',
        label: 'visible',
        revision: 1n,
      }),
    ).toEqual([]);

    // a visible label with no backing claim and a negation of the truth
    expect(
      violatedInvariants(model, {
        claim: 'none',
        label: 'visible',
        revision: 0n,
      }),
    ).toEqual(['LabelIsView', 'VisibleBackedByClaim', 'NoLabelWithoutClaim']);

    expect(
      violatedInvariants(model, {
        claim: 'filed',
        label: 'negated',
        revision: 1n,
      }),
    ).toEqual(['LabelIsView', 'NegationDeniesClaim']);
  });
});
