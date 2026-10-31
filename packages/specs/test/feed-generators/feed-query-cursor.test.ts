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
import definitionJson from '../../src/feed-generators/feed-query-cursor.model.generated.json';

// Spec-only verification for the feed-generator query cursor. The reference
// model IS the spec; no runtime is involved. Every step is checked for
// invariant violations, and the cursor/dedupe discipline gets explicit
// boundary coverage.

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

describe('feed query cursor: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('feed_generators_feed_query_cursor');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StatusValid',
      'AccountingExact',
      'CursorTracksServed',
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

describe('feed query cursor: invariants under exploration', () => {
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

  it('the fetched ledger stays balanced and the cursor tracks served uniquely', () => {
    const sessionEvents = eventsOf(model).filter(
      (event) => event._tag !== 'init',
    );
    let state = model.initial;
    const indexes = [...Array(400).keys()].map(
      (i) => (i * 37 + 5) % sessionEvents.length,
    );
    for (const index of indexes) {
      const event = sessionEvents[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      expect(number(state, 'fetched')).toBe(
        number(state, 'served') + number(state, 'deduped'),
      );
      expect(number(state, 'cursor')).toBe(number(state, 'served'));
    }
  });
});

describe('feed query cursor: boundary behavior', () => {
  it('fresh pages advance the cursor; a zero-fresh page exhausts the feed', () => {
    let state = run([{ _tag: 'open' }, { _tag: 'page', fresh: 2n }]);
    expect({
      status: text(state, 'status'),
      fetched: number(state, 'fetched'),
      served: number(state, 'served'),
      cursor: number(state, 'cursor'),
    }).toEqual({
      status: 'serving',
      fetched: 2n,
      served: 2n,
      cursor: 2n,
    });

    state = model.transition(state, { _tag: 'page', fresh: 0n });
    expect({
      status: text(state, 'status'),
      pages: number(state, 'pages'),
    }).toEqual({ status: 'exhausted', pages: 2n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a replay of already-seen records is deduped and never moves the cursor', () => {
    let state = run([
      { _tag: 'open' },
      { _tag: 'page', fresh: 2n },
      { _tag: 'replay', stale: 1n },
    ]);
    expect({
      fetched: number(state, 'fetched'),
      served: number(state, 'served'),
      deduped: number(state, 'deduped'),
      cursor: number(state, 'cursor'),
    }).toEqual({ fetched: 3n, served: 2n, deduped: 1n, cursor: 2n });
    expect(violatedInvariants(model, state)).toEqual([]);

    state = model.transition(state, { _tag: 'replay', stale: 2n });
    expect({
      fetched: number(state, 'fetched'),
      served: number(state, 'served'),
      deduped: number(state, 'deduped'),
      cursor: number(state, 'cursor'),
    }).toEqual({ fetched: 5n, served: 2n, deduped: 3n, cursor: 2n });
  });

  it('paging while idle changes nothing', () => {
    const state = run([{ _tag: 'page', fresh: 3n }]);
    expect({
      status: text(state, 'status'),
      fetched: number(state, 'fetched'),
      served: number(state, 'served'),
    }).toEqual({ status: 'idle', fetched: 0n, served: 0n });
    expect(stateKey(model, state)).toBe(stateKey(model, model.initial));
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        status: 'serving',
        fetched: 3n,
        served: 2n,
        deduped: 1n,
        cursor: 2n,
        pages: 1n,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        status: 'broken',
        fetched: 1n,
        served: 3n,
        deduped: 0n,
        cursor: 5n,
        pages: -1n,
      }),
    ).toEqual([
      'StatusValid',
      'AccountingExact',
      'CursorTracksServed',
      'CountersNonNegative',
    ]);
  });
});
