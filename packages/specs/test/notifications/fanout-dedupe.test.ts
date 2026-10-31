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
import definitionJson from '../../src/notifications/fanout-dedupe.model.generated.json';

// Spec-only verification for the notifications fan-out + dedupe machine: one
// event fans out to the recipient set it addresses, a re-delivery is deduped,
// and each account's read cursor never runs past its inbox. The reference model
// IS the spec; no runtime is involved.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const number = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('notifications fan-out dedupe: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('notifications_fanout_dedupe');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'ReadCursorWithinInbox',
      'InboxWithinEvents',
      'CountersNonNegative',
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

describe('notifications fan-out dedupe: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 250, seed });
      expect(violations).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('delivered counts never outrun accepted events and cursors never pass inboxes', () => {
    const withoutInit = eventsOf(model).filter(
      (event) => event._tag !== 'init',
    );
    const indices = [...Array(400).keys()].map(
      (i) => (i * 29 + 3) % withoutInit.length,
    );
    let state = model.initial;
    for (const index of indices) {
      const event = withoutInit[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      expect(number(state, 'inboxA') <= number(state, 'eventCount')).toBe(true);
      expect(number(state, 'cursorA') <= number(state, 'inboxA')).toBe(true);
      expect(number(state, 'cursorB') <= number(state, 'inboxB')).toBe(true);
    }
  });
});

describe('notifications fan-out dedupe: boundary behavior', () => {
  it('fan-out addresses only the named recipients and reads clamp at the inbox', () => {
    let state = run([
      { _tag: 'fanout', audience: 'recipientA' },
      { _tag: 'fanout', audience: 'both' },
    ]);
    expect({
      eventCount: number(state, 'eventCount'),
      inboxA: number(state, 'inboxA'),
      inboxB: number(state, 'inboxB'),
    }).toEqual({ eventCount: 2n, inboxA: 2n, inboxB: 1n });

    // reading past the inbox stops at the inbox
    state = model.transition(state, { _tag: 'readA', n: 3n });
    state = model.transition(state, { _tag: 'readB', n: 3n });
    expect({
      cursorA: number(state, 'cursorA'),
      cursorB: number(state, 'cursorB'),
    }).toEqual({ cursorA: 2n, cursorB: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a re-delivery only bumps the dropped counter', () => {
    let state = run([{ _tag: 'fanout', audience: 'both' }]);
    const before = stateKey(model, state);

    state = model.transition(state, { _tag: 'redeliver', audience: 'both' });
    expect({
      eventCount: number(state, 'eventCount'),
      inboxA: number(state, 'inboxA'),
      inboxB: number(state, 'inboxB'),
      dropped: number(state, 'dropped'),
    }).toEqual({ eventCount: 1n, inboxA: 1n, inboxB: 1n, dropped: 1n });
    // dedupe changed the dropped counter (so the state key differs), but no
    // inbox or cursor moved
    expect(stateKey(model, state)).not.toBe(before);
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        eventCount: 3n,
        inboxA: 3n,
        inboxB: 2n,
        cursorA: 3n,
        cursorB: 2n,
        dropped: 0n,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        eventCount: 1n,
        inboxA: 3n,
        inboxB: 0n,
        cursorA: 5n,
        cursorB: -1n,
        dropped: 0n,
      }),
    ).toEqual([
      'ReadCursorWithinInbox',
      'InboxWithinEvents',
      'CountersNonNegative',
    ]);
  });
});
