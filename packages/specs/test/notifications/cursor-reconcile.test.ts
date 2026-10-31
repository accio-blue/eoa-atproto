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
import definitionJson from '../../src/notifications/cursor-reconcile.model.generated.json';

// Spec-only verification for the notifications cursor-reconciliation machine:
// the account's read cursor advances only on the next contiguous notification;
// a forward gap parks it until reconciliation refetches the missing range. The
// cursor never runs ahead of the canonical head. The reference model IS the
// spec; no runtime is involved.

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

describe('notifications cursor reconcile: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('notifications_cursor_reconcile');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'CursorNeverAhead',
      'MissingWithinHead',
      'ModeValid',
      'GappedHasMissing',
      'SyncedHasNoGap',
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

describe('notifications cursor reconcile: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 250, seed });
      expect(violations).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 12, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('the cursor never passes the head and every step keeps the invariants', () => {
    const withoutInit = eventsOf(model).filter(
      (event) => event._tag !== 'init',
    );
    const indices = [...Array(500).keys()].map(
      (i) => (i * 37 + 5) % withoutInit.length,
    );
    let state = model.initial;
    for (const index of indices) {
      const event = withoutInit[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      expect(number(state, 'cursor') <= number(state, 'headSeq')).toBe(true);
    }
  });
});

describe('notifications cursor reconcile: boundary behavior', () => {
  it('a forward gap parks the cursor until reconciliation catches it up', () => {
    let state = run([
      { _tag: 'publish', delta: 2n },
      { _tag: 'consume', offset: 1n },
    ]);
    expect({
      headSeq: number(state, 'headSeq'),
      cursor: number(state, 'cursor'),
      mode: String(state['mode']),
    }).toEqual({ headSeq: 2n, cursor: 1n, mode: 'synced' });

    // offset 4 skips sequence 2: record the gap and park
    state = model.transition(state, { _tag: 'consume', offset: 4n });
    expect({
      cursor: number(state, 'cursor'),
      missingAt: number(state, 'missingAt'),
      mode: String(state['mode']),
    }).toEqual({ cursor: 1n, missingAt: 2n, mode: 'gapped' });

    // deliveries are ignored while gapped, and the head may still advance
    state = model.transition(state, { _tag: 'consume', offset: 1n });
    state = model.transition(state, { _tag: 'publish', delta: 1n });
    expect({
      cursor: number(state, 'cursor'),
      headSeq: number(state, 'headSeq'),
    }).toEqual({ cursor: 1n, headSeq: 3n });

    state = model.transition(state, { _tag: 'reconcile' });
    expect({
      cursor: number(state, 'cursor'),
      missingAt: number(state, 'missingAt'),
      mode: String(state['mode']),
    }).toEqual({ cursor: 3n, missingAt: 0n, mode: 'synced' });
    expect(violatedInvariants(model, state)).toEqual([]);
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        headSeq: 3n,
        cursor: 3n,
        missingAt: 0n,
        mode: 'synced',
      }),
    );
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        headSeq: 3n,
        cursor: 3n,
        missingAt: 0n,
        mode: 'synced',
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        headSeq: 1n,
        cursor: 5n,
        missingAt: 7n,
        mode: 'gapped',
      }),
    ).toEqual(['CursorNeverAhead', 'MissingWithinHead']);

    // a gapped mode must always name the missing sequence
    expect(
      violatedInvariants(model, {
        headSeq: 1n,
        cursor: 0n,
        missingAt: 0n,
        mode: 'gapped',
      }),
    ).toEqual(['GappedHasMissing']);
  });
});
