import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/relay/subscription-cursor.model.generated.json';

// Spec-only verification for the relay's upstream subscription cursor. The
// reference model IS the spec; no machine implementation is involved. Every
// step is checked for invariant violations, and the cursor discipline gets
// explicit boundary coverage.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const status = (state: QuintModelValue) => String(state['status']);
const cursor = (state: QuintModelValue) => BigInt(state['cursor'] ?? 0n);
const resume = (state: QuintModelValue) => BigInt(state['resume'] ?? 0n);

describe('relay subscription cursor: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('relay_subscription_cursor');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StatusValid',
      'CursorNonNegative',
      'AttemptsNonNegative',
      'NoGapSkipped',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    expect(events.length).toBeGreaterThan(definition.step.length);
  });
});

describe('relay subscription cursor: invariants hold under exploration', () => {
  const events = eventsOf(model);

  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(
        simulate(model, { runs: 1, maxSteps: 250, seed }).violations,
      ).toEqual([]);
    }
  });

  it('the cursor never decreases and resume always trails the cursor', () => {
    // init starts a fresh session (cursor resets to 0), so the monotonic
    // property is asserted over the session events only
    const sessionEvents = events.filter((event) => event._tag !== 'init');
    let state = model.initial;
    let previous = cursor(state);
    const indexes = [...Array(500).keys()].map(
      (i) => (i * 37 + 11) % sessionEvents.length,
    );
    for (const index of indexes) {
      const event = sessionEvents[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      const next = cursor(state);
      expect(next >= previous).toBe(true);
      expect(violatedInvariants(model, state)).toEqual([]);
      previous = next;
    }
  });
});

describe('relay subscription cursor: boundary behavior', () => {
  it('in-order commits advance the cursor by exactly one', () => {
    let state = run([{ _tag: 'subscribe' }, { _tag: 'open' }]);
    expect({
      status: status(state),
      cursor: cursor(state),
      resume: resume(state),
    }).toEqual({
      status: 'live',
      cursor: 0n,
      resume: 1n,
    });

    state = model.transition(state, { _tag: 'commit', delta: 1n });
    expect({ cursor: cursor(state), resume: resume(state) }).toEqual({
      cursor: 1n,
      resume: 2n,
    });

    state = model.transition(state, { _tag: 'commit', delta: 1n });
    expect({
      status: status(state),
      cursor: cursor(state),
      resume: resume(state),
    }).toEqual({
      status: 'live',
      cursor: 2n,
      resume: 3n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('stale and duplicate deltas are ignored entirely', () => {
    let state = run([
      { _tag: 'subscribe' },
      { _tag: 'open' },
      { _tag: 'commit', delta: 1n },
      { _tag: 'commit', delta: 1n },
    ]);
    expect(cursor(state)).toBe(2n);

    state = model.transition(state, { _tag: 'commit', delta: 0n });
    expect({
      status: status(state),
      cursor: cursor(state),
      resume: resume(state),
    }).toEqual({
      status: 'live',
      cursor: 2n,
      resume: 3n,
    });

    state = model.transition(state, { _tag: 'commit', delta: -1n });
    expect({
      status: status(state),
      cursor: cursor(state),
      resume: resume(state),
    }).toEqual({
      status: 'live',
      cursor: 2n,
      resume: 3n,
    });
  });

  it('a forward gap reconnects into backfill without jumping the cursor', () => {
    let state = run([
      { _tag: 'subscribe' },
      { _tag: 'open' },
      { _tag: 'commit', delta: 1n },
      { _tag: 'commit', delta: 1n },
    ]);
    expect(cursor(state)).toBe(2n);

    // gap: enter backfill, cursor and resume stay put
    state = model.transition(state, { _tag: 'commit', delta: 5n });
    expect({
      status: status(state),
      cursor: cursor(state),
      resume: resume(state),
    }).toEqual({
      status: 'backfilling',
      cursor: 2n,
      resume: 3n,
    });

    // while backfilling, in-order commits are not consumed
    state = model.transition(state, { _tag: 'commit', delta: 1n });
    expect({ status: status(state), cursor: cursor(state) }).toEqual({
      status: 'backfilling',
      cursor: 2n,
    });

    // backfill drains the gap and returns to live, still without jumping
    state = model.transition(state, { _tag: 'backfill' });
    expect({
      status: status(state),
      cursor: cursor(state),
      resume: resume(state),
    }).toEqual({
      status: 'live',
      cursor: 2n,
      resume: 3n,
    });
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        status: 'live',
        cursor: 3n,
        resume: 4n,
        attempts: 1n,
      }),
    ).toEqual([]);
    expect(
      violatedInvariants(model, {
        status: 'zombie',
        cursor: -1n,
        resume: 5n,
        attempts: -2n,
      }),
    ).toEqual([
      'StatusValid',
      'CursorNonNegative',
      'AttemptsNonNegative',
      'NoGapSkipped',
    ]);
  });
});
