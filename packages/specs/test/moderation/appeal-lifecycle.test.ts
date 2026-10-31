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
import definitionJson from '../../src/moderation/appeal-lifecycle.model.generated.json';

// Spec-only verification for the moderation appeal window + review: an
// enforcement action opens a filing window, one appeal may be filed while it is
// open, and the ruling either reverses or keeps the action. The reference model
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

describe('moderation appeal lifecycle: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('moderation_appeal_lifecycle');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'AppealValid',
      'FilingValid',
      'AppealNeedsOpenFiling',
      'LapsedHasNoAppeal',
      'GrantedReverses',
      'DeniedKeepsStanding',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the rule pool expands over grant / deny
    expect(
      events
        .filter((event) => event._tag === 'rule')
        .map((event) => event['grant'])
        .sort(),
    ).toEqual([false, true]);
  });
});

describe('moderation appeal lifecycle: invariants under exploration', () => {
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

  it('a filed appeal always sits on an open window', () => {
    const events = eventsOf(model);
    let state = model.initial;
    for (let index = 0; index < 300; index += 1) {
      const event = events[(index * 13 + 1) % events.length];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      if (field(state, 'appeal') !== 'none') {
        expect(field(state, 'filing')).toBe('open');
      }
    }
  });
});

describe('moderation appeal lifecycle: boundary behavior', () => {
  it('a granted appeal reverses the action', () => {
    let state = run([{ _tag: 'enforce' }, { _tag: 'file' }]);
    expect({
      appeal: field(state, 'appeal'),
      filing: field(state, 'filing'),
      standing: state['standing'],
    }).toEqual({ appeal: 'filed', filing: 'open', standing: true });

    state = model.transition(state, { _tag: 'review' });
    state = model.transition(state, { _tag: 'rule', grant: true });
    expect({
      appeal: field(state, 'appeal'),
      standing: state['standing'],
    }).toEqual({ appeal: 'granted', standing: false });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a lapsed window can never be filed against', () => {
    let state = run([{ _tag: 'enforce' }, { _tag: 'lapse' }]);
    expect(field(state, 'filing')).toBe('lapsed');

    state = model.transition(state, { _tag: 'file' });
    expect(field(state, 'appeal')).toBe('none');
    state = model.transition(state, { _tag: 'review' });
    expect(field(state, 'appeal')).toBe('none');
    expect(violatedInvariants(model, state)).toEqual([]);
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        appeal: 'none',
        filing: 'lapsed',
        standing: true,
      }),
    );
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        appeal: 'granted',
        filing: 'lapsed',
        standing: true,
      }),
    ).toEqual([
      'AppealNeedsOpenFiling',
      'LapsedHasNoAppeal',
      'GrantedReverses',
    ]);
  });
});
