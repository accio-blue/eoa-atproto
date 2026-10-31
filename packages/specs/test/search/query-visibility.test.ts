import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, verifySpec } from '@quint-machine/core/testing';
import definitionJson from '../../src/search/query-visibility.model.generated.json';

// Spec-only verification for search's query visibility gate: visibility
// follows the subject. A public subject's documents are visible to all; a
// private subject's documents are visible only through the fail-closed grant
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

describe('search query visibility: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('search_query_visibility');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'VisibilityValid',
      'DecisionValid',
      'PrivateResultsRequireGrant',
      'PublicNeverEmpty',
      'NoDecisionWithoutQuery',
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

describe('search query visibility: invariants hold under exploration', () => {
  it('no invariant fails on exploration or seeded random walks', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(() =>
        verifySpec(model, {
          maxDepth: 8,
          maxStates: 5000,
          runs: 1,
          maxSteps: 200,
          seed,
        }),
      ).not.toThrow();
    }
  });

  it('reaches a visible private subject and never empties a public one', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) =>
          state['visibility'] === 'private' && state['decision'] === 'results',
      ),
    ).toBe(true);
    expect(
      report.reachable(
        (state) =>
          state['visibility'] === 'public' && state['decision'] === 'empty',
      ),
    ).toBe(false);
  });
});

describe('search query visibility: boundaries', () => {
  it('a public subject returns results regardless of any grant', () => {
    let state = step([{ _tag: 'setVisibility', v: 'public' }]);
    state = model.transition(state, { _tag: 'runQuery' });
    expect({
      visibility: field(state, 'visibility'),
      decision: decision(state),
    }).toEqual({ visibility: 'public', decision: 'results' });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a private subject returns results only through the grant oracle', () => {
    // private, no grant: empty
    let state = step([
      { _tag: 'setVisibility', v: 'private' },
      { _tag: 'runQuery' },
    ]);
    expect(decision(state)).toBe('empty');

    // active grant, matching subject, matching selector, not expired: results
    state = [
      { _tag: 'setGrant', g: 'active' },
      { _tag: 'setSubjectMatchesViewer', b: true },
      { _tag: 'setSelectorOk', b: true },
      { _tag: 'setExpired', b: false },
      { _tag: 'runQuery' },
    ].reduce((current, event) => model.transition(current, event), state);
    expect({
      visibility: field(state, 'visibility'),
      decision: decision(state),
    }).toEqual({ visibility: 'private', decision: 'results' });
    expect(violatedInvariants(model, state)).toEqual([]);

    // an expired grant fails closed: empty again
    state = model.transition(state, { _tag: 'setExpired', b: true });
    state = model.transition(state, { _tag: 'runQuery' });
    expect(decision(state)).toBe('empty');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    // a private subject returning results with no grant
    expect(
      violatedInvariants(model, {
        visibility: 'private',
        grant: 'none',
        subjectMatchesViewer: true,
        selectorOk: true,
        expired: false,
        requested: true,
        decision: 'results',
      }),
    ).toEqual(['PrivateResultsRequireGrant']);

    // a public subject emptied by a query
    expect(
      violatedInvariants(model, {
        visibility: 'public',
        grant: 'none',
        subjectMatchesViewer: false,
        selectorOk: false,
        expired: false,
        requested: true,
        decision: 'empty',
      }),
    ).toEqual(['PublicNeverEmpty']);

    // a decision with no query behind it
    expect(
      violatedInvariants(model, {
        visibility: 'public',
        grant: 'none',
        subjectMatchesViewer: false,
        selectorOk: false,
        expired: false,
        requested: false,
        decision: 'results',
      }),
    ).toEqual(['NoDecisionWithoutQuery']);
  });
});
