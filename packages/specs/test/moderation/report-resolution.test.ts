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
import definitionJson from '../../src/moderation/report-resolution.model.generated.json';

// Spec-only verification for the moderation report -> action -> appeal spine:
// a report is submitted, triaged, and resolved with a takedown, label, or
// dismissal; only an enforceable verdict can be appealed. The reference model
// IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const field = (state: QuintModelValue, name: string) => String(state[name]);

describe('moderation report resolution: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('moderation_report_resolution');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'ReportValid',
      'DecisionValid',
      'AppealValid',
      'DecisionNeedsResolution',
      'DismissedIsNoAction',
      'AppealNeedsEnforcement',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the decide pool expands over its three verdicts
    expect(
      events
        .filter((event) => event._tag === 'decide')
        .map((event) => event['verdict'])
        .sort(),
    ).toEqual(['label', 'noaction', 'takedown']);
  });
});

describe('moderation report resolution: invariants under exploration', () => {
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
    const report = explore(model, { maxDepth: 12, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('an appeal never appears before an enforceable resolution', () => {
    const events = eventsOf(model);
    let state = model.initial;
    for (let index = 0; index < 300; index += 1) {
      const event = events[(index * 13 + 1) % events.length];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      if (field(state, 'appeal') !== 'none') {
        expect(field(state, 'report')).toBe('resolved');
        expect(['takedown', 'label']).toContain(field(state, 'decision'));
      }
    }
  });
});

describe('moderation report resolution: boundary behavior', () => {
  it('resolves with a takedown and a granted appeal', () => {
    let state = run([{ _tag: 'submit' }, { _tag: 'triage' }]);
    expect(field(state, 'report')).toBe('triaged');

    state = model.transition(state, { _tag: 'decide', verdict: 'takedown' });
    state = model.transition(state, { _tag: 'fileAppeal' });
    state = model.transition(state, {
      _tag: 'decideAppeal',
      ruling: 'granted',
    });
    expect({
      report: field(state, 'report'),
      decision: field(state, 'decision'),
      appeal: field(state, 'appeal'),
    }).toEqual({
      report: 'resolved',
      decision: 'takedown',
      appeal: 'granted',
    });
    expect(violatedInvariants(model, state)).toEqual([]);

    // a second ruling cannot restart a decided appeal
    state = model.transition(state, { _tag: 'decideAppeal', ruling: 'denied' });
    expect(field(state, 'appeal')).toBe('granted');
  });

  it('a dismissal cannot be appealed', () => {
    let state = run([{ _tag: 'submit' }, { _tag: 'triage' }]);
    state = model.transition(state, { _tag: 'decide', verdict: 'noaction' });
    expect({
      report: field(state, 'report'),
      decision: field(state, 'decision'),
    }).toEqual({ report: 'dismissed', decision: 'noaction' });

    state = model.transition(state, { _tag: 'fileAppeal' });
    expect(field(state, 'appeal')).toBe('none');
    expect(violatedInvariants(model, state)).toEqual([]);
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        report: 'dismissed',
        decision: 'noaction',
        appeal: 'none',
      }),
    );
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        report: 'zombie',
        decision: 'takedown',
        appeal: 'filed',
      }),
    ).toEqual([
      'ReportValid',
      'DecisionNeedsResolution',
      'AppealNeedsEnforcement',
    ]);
  });
});
