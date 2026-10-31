import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, verifySpec } from '@quint-machine/core/testing';
import definitionJson from '../../src/backlink-index/visibility-gate.model.generated.json';

// Spec-only verification for backlink-index's visibility gate: visibility
// follows the subject. A public subject's backlinks are visible to all; a
// private subject's backlinks are visible only through the fail-closed grant
// oracle. The reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const decision = (state: QuintModelValue) => String(state['decision']);
const field = (state: QuintModelValue, name: string) => String(state[name]);

describe('backlink visibility gate: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('backlink_visibility_gate');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'VisibilityValid',
      'DecisionValid',
      'PrivateRequiresGrant',
      'PublicNeverHidden',
      'NoDecisionWithoutLookup',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    expect(events.length).toBeGreaterThan(definition.step.length);
  });
});

describe('backlink visibility gate: invariants hold under exploration', () => {
  it('no invariant fails on exploration or seeded random walks', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(() =>
        verifySpec(model, {
          maxDepth: 6,
          maxStates: 5000,
          runs: 1,
          maxSteps: 200,
          seed,
        }),
      ).not.toThrow();
    }
  });

  it('reaches a visible private subject and never hides a public one', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) =>
          state['visibility'] === 'private' && state['decision'] === 'visible',
      ),
    ).toBe(true);
    expect(
      report.reachable(
        (state) =>
          state['visibility'] === 'public' && state['decision'] === 'hidden',
      ),
    ).toBe(false);
  });
});

describe('backlink visibility gate: boundaries', () => {
  it('a public subject is visible regardless of any grant', () => {
    let state = step([{ _tag: 'setVisibility', v: 'public' }]);
    state = model.transition(state, { _tag: 'lookup' });
    expect({
      visibility: field(state, 'visibility'),
      decision: decision(state),
    }).toEqual({ visibility: 'public', decision: 'visible' });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a private subject is visible only through the grant oracle', () => {
    // private, no grant: hidden
    let state = step([
      { _tag: 'setVisibility', v: 'private' },
      { _tag: 'lookup' },
    ]);
    expect(decision(state)).toBe('hidden');

    // active grant, matching subject, matching selector, not expired: visible
    state = [
      { _tag: 'setGrant', g: 'active' },
      { _tag: 'setSubjectMatchesViewer', b: true },
      { _tag: 'setSelectorOk', b: true },
      { _tag: 'setExpired', b: false },
      { _tag: 'lookup' },
    ].reduce((current, event) => model.transition(current, event), state);
    expect({
      visibility: field(state, 'visibility'),
      decision: decision(state),
    }).toEqual({ visibility: 'private', decision: 'visible' });
    expect(violatedInvariants(model, state)).toEqual([]);

    // an expired grant fails closed: hidden again
    state = model.transition(state, { _tag: 'setExpired', b: true });
    state = model.transition(state, { _tag: 'lookup' });
    expect(decision(state)).toBe('hidden');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    // a private subject visible with no grant
    expect(
      violatedInvariants(model, {
        visibility: 'private',
        grant: 'none',
        subjectMatchesViewer: true,
        selectorOk: true,
        expired: false,
        requested: true,
        decision: 'visible',
      }),
    ).toEqual(['PrivateRequiresGrant']);

    // a public subject hidden from a lookup
    expect(
      violatedInvariants(model, {
        visibility: 'public',
        grant: 'none',
        subjectMatchesViewer: false,
        selectorOk: false,
        expired: false,
        requested: true,
        decision: 'hidden',
      }),
    ).toEqual(['PublicNeverHidden']);

    // a decision with no lookup behind it
    expect(
      violatedInvariants(model, {
        visibility: 'public',
        grant: 'none',
        subjectMatchesViewer: false,
        selectorOk: false,
        expired: false,
        requested: false,
        decision: 'visible',
      }),
    ).toEqual(['NoDecisionWithoutLookup']);
  });
});
