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
import definitionJson from '../../src/labeler/label-lifecycle.model.generated.json';

// Spec-only verification for the labeler's label lifecycle + stream position:
// a label is issued, then negated, retracted, or expired; the `active` view is
// the pure projection of the lifecycle, and a subscriber's cursor never runs
// ahead of the published stream. The reference model IS the spec.

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
const count = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('labeler label lifecycle: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('labeler_label_lifecycle');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StatusValid',
      'ActiveIsView',
      'NegOnlyWhenSuperseded',
      'ExpiredNotTombstone',
      'CursorNeverAhead',
      'CursorNonNegative',
      'PublishedNonNegative',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the ack pool expands over its three increments
    expect(
      events
        .filter((event) => event._tag === 'ack')
        .map((event) => event['n'])
        .sort(),
    ).toEqual([1n, 2n, 5n]);
  });
});

describe('labeler label lifecycle: invariants under exploration', () => {
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
    expect(report.reachable((state) => state['status'] === 'issued')).toBe(
      true,
    );
    expect(report.reachable((state) => state['status'] === 'negated')).toBe(
      true,
    );
    expect(report.reachable((state) => state['status'] === 'expired')).toBe(
      true,
    );
  });
});

describe('labeler label lifecycle: boundary behavior', () => {
  it('issue -> negate emits a tombstone and clears the active view', () => {
    let state = run([{ _tag: 'emit' }]);
    expect({
      status: text(state, 'status'),
      neg: flag(state, 'neg'),
      active: flag(state, 'active'),
      published: count(state, 'published'),
      cursor: count(state, 'cursor'),
    }).toEqual({
      status: 'issued',
      neg: false,
      active: true,
      published: 1n,
      cursor: 0n,
    });

    state = model.transition(state, { _tag: 'negate' });
    expect({
      status: text(state, 'status'),
      neg: flag(state, 'neg'),
      active: flag(state, 'active'),
      published: count(state, 'published'),
    }).toEqual({
      status: 'negated',
      neg: true,
      active: false,
      published: 2n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);

    // a further retraction is a no-op once the label is superseded
    state = model.transition(state, { _tag: 'retract' });
    expect({
      status: text(state, 'status'),
      published: count(state, 'published'),
    }).toEqual({
      status: 'negated',
      published: 2n,
    });
  });

  it('the subscriber cursor is clamped to the published stream', () => {
    let state = run([{ _tag: 'emit' }, { _tag: 'negate' }]);
    expect(count(state, 'published')).toBe(2n);

    state = model.transition(state, { _tag: 'ack', n: 5n });
    expect({
      cursor: count(state, 'cursor'),
      published: count(state, 'published'),
    }).toEqual({ cursor: 2n, published: 2n });
    expect(violatedInvariants(model, state)).toEqual([]);
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        status: 'negated',
        neg: true,
        active: false,
        published: 2n,
        cursor: 2n,
      }),
    );
  });

  it('expiry clears the view without emitting a tombstone', () => {
    const state = run([{ _tag: 'emit' }, { _tag: 'expire' }]);
    expect({
      status: text(state, 'status'),
      neg: flag(state, 'neg'),
      active: flag(state, 'active'),
      published: count(state, 'published'),
    }).toEqual({
      status: 'expired',
      neg: false,
      active: false,
      published: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        status: 'issued',
        neg: false,
        active: true,
        published: 1n,
        cursor: 1n,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        status: 'issued',
        neg: true,
        active: true,
        published: 0n,
        cursor: 3n,
      }),
    ).toEqual(['ActiveIsView', 'NegOnlyWhenSuperseded', 'CursorNeverAhead']);
  });
});
