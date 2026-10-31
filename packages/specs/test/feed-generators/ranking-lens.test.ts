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
import definitionJson from '../../src/feed-generators/ranking-lens.model.generated.json';

// Spec-only verification for the feed ranking lens. The reference model IS the
// spec; no runtime is involved. Every step is checked for invariant
// violations, and the gate/dedupe/placement accounting gets explicit boundary
// coverage.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const text = (state: QuintModelValue, field: string) =>
  String(state[field] ?? '');
const number = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('ranking lens: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('feed_generators_ranking_lens');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'LensValid',
      'AccountingExact',
      'SlotTracksRanked',
      'CountersNonNegative',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    const stepTags = definition.step.filter((tag) => tag !== 'init');
    expect(tags).toEqual(stepTags.sort());
    expect(events.length).toBeGreaterThan(stepTags.length);
  });
});

describe('ranking lens: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(
        simulate(model, { runs: 1, maxSteps: 250, seed }).violations,
      ).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('every observed candidate is accounted for and slots never outrun rank', () => {
    const sessionEvents = eventsOf(model).filter(
      (event) => event._tag !== 'init',
    );
    let state = model.initial;
    const indexes = [...Array(400).keys()].map(
      (i) => (i * 41 + 9) % sessionEvents.length,
    );
    for (const index of indexes) {
      const event = sessionEvents[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      expect(number(state, 'observed')).toBe(
        number(state, 'blocked') +
          number(state, 'duplicate') +
          number(state, 'pending') +
          number(state, 'ranked') +
          number(state, 'suppressed'),
      );
      expect(number(state, 'slot')).toBe(number(state, 'ranked'));
    }
  });
});

describe('ranking lens: boundary behavior', () => {
  it('gates, dedupes, then places survivors into ordered slots', () => {
    let state = run([{ _tag: 'chooseLens', choice: 'discovery' }]);
    expect(text(state, 'lens')).toBe('discovery');

    for (const outcome of ['public', 'public', 'repeat', 'blocked'] as const) {
      state = model.transition(state, { _tag: 'observe', outcome });
    }
    expect({
      observed: number(state, 'observed'),
      blocked: number(state, 'blocked'),
      duplicate: number(state, 'duplicate'),
      pending: number(state, 'pending'),
    }).toEqual({
      observed: 4n,
      blocked: 1n,
      duplicate: 1n,
      pending: 2n,
    });

    state = model.transition(state, { _tag: 'place', decision: 'rank' });
    state = model.transition(state, { _tag: 'place', decision: 'suppress' });
    expect({
      pending: number(state, 'pending'),
      ranked: number(state, 'ranked'),
      suppressed: number(state, 'suppressed'),
      slot: number(state, 'slot'),
    }).toEqual({ pending: 0n, ranked: 1n, suppressed: 1n, slot: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('placing with nothing pending is a no-op', () => {
    const before = run([{ _tag: 'chooseLens', choice: 'discovery' }]);
    const after = model.transition(before, {
      _tag: 'place',
      decision: 'rank',
    });
    expect(stateKey(model, after)).toBe(stateKey(model, before));
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        lens: 'discovery',
        observed: 4n,
        blocked: 1n,
        duplicate: 1n,
        pending: 0n,
        ranked: 1n,
        suppressed: 1n,
        slot: 1n,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        lens: 'zombie',
        observed: 1n,
        blocked: 1n,
        duplicate: 0n,
        pending: 0n,
        ranked: 1n,
        suppressed: 0n,
        slot: 9n,
      }),
    ).toEqual(['LensValid', 'AccountingExact', 'SlotTracksRanked']);
  });
});
