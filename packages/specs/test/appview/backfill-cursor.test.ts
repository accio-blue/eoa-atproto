import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/appview/backfill-cursor.model.generated.json';

// Spec-only verification for the appview backfill-vs-live cursor
// reconciliation. The reference model IS the spec; no machine implementation
// is involved. The boundary cases pin the reconciliation rules that the
// machine must preserve: a covered live event is ignored, a live event beyond
// the target is deferred, and a stale backfill page never re-applies.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const mode = (state: QuintModelValue) => String(state['mode']);
const target = (state: QuintModelValue) => BigInt(state['target'] ?? 0n);
const backfillCursor = (state: QuintModelValue) =>
  BigInt(state['backfillCursor'] ?? 0n);
const liveCursor = (state: QuintModelValue) =>
  BigInt(state['liveCursor'] ?? 0n);
const deferred = (state: QuintModelValue) => BigInt(state['deferred'] ?? 0n);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('appview backfill cursor: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('appview_backfill_cursor');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NoDoubleApply',
      'BackfillWithinTarget',
      'CursorMonotonic',
      'HandoffConsistent',
      'CursorsNonNegative',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    const steps = definition.step.filter((tag) => tag !== 'init').sort();
    expect(tags).toEqual(steps);
    expect(events.length).toBeGreaterThan(definition.step.length);
  });
});

describe('appview backfill cursor: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 250, seed });
      expect(
        violations.map((violation) => ({
          step: violation.step,
          event: violation.path.at(-1),
          invariants: violation.invariants,
        })),
      ).toEqual([]);
    }
  });
});

describe('appview backfill cursor: reconciliation boundaries', () => {
  it('a live event beyond the backfill point is deferred, never applied', () => {
    let state = step([{ _tag: 'startBackfill', startTarget: 3n }]);
    expect({ mode: mode(state), target: target(state) }).toEqual({
      mode: 'backfilling',
      target: 3n,
    });

    // seq 5 is past the target: held, not applied
    state = model.transition(state, { _tag: 'liveEvent', seq: 5n });
    expect({
      mode: mode(state),
      liveCursor: liveCursor(state),
      deferred: deferred(state),
    }).toEqual({ mode: 'backfilling', liveCursor: 0n, deferred: 1n });

    // seq 2 is covered by history: ignored, not applied
    state = model.transition(state, { _tag: 'liveEvent', seq: 2n });
    expect({
      liveCursor: liveCursor(state),
      deferred: deferred(state),
    }).toEqual({ liveCursor: 0n, deferred: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a stale backfill page is ignored and the target hands over to live', () => {
    let state = step([{ _tag: 'startBackfill', startTarget: 3n }]);

    // forward page advances the backfill cursor
    state = model.transition(state, { _tag: 'backfillEvent', seq: 1n });
    expect(backfillCursor(state)).toBe(1n);

    // stale page (already covered) is ignored
    state = model.transition(state, { _tag: 'backfillEvent', seq: 0n });
    expect({
      mode: mode(state),
      backfillCursor: backfillCursor(state),
    }).toEqual({ mode: 'backfilling', backfillCursor: 1n });

    // page at/over the target hands over without jumping past it
    state = model.transition(state, { _tag: 'backfillEvent', seq: 3n });
    expect({
      mode: mode(state),
      backfillCursor: backfillCursor(state),
      liveCursor: liveCursor(state),
    }).toEqual({ mode: 'live', backfillCursor: 3n, liveCursor: 3n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a stale live event never moves the cursor back, and deferred drain in order', () => {
    // hand over, then accept a live event past the target
    let state = step([
      { _tag: 'startBackfill', startTarget: 3n },
      { _tag: 'liveEvent', seq: 5n },
      { _tag: 'backfillEvent', seq: 3n },
    ]);
    expect({
      mode: mode(state),
      deferred: deferred(state),
      liveCursor: liveCursor(state),
    }).toEqual({ mode: 'live', deferred: 1n, liveCursor: 3n });

    state = model.transition(state, { _tag: 'liveEvent', seq: 6n });
    expect(liveCursor(state)).toBe(6n);

    // stale live delivery: ignored
    state = model.transition(state, { _tag: 'liveEvent', seq: 3n });
    expect(liveCursor(state)).toBe(6n);

    // drain the one deferred delivery after handover
    state = model.transition(state, { _tag: 'drainDeferred' });
    expect({
      deferred: deferred(state),
      liveCursor: liveCursor(state),
    }).toEqual({ deferred: 0n, liveCursor: 7n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    expect(
      violatedInvariants(model, {
        mode: 'live',
        target: 3n,
        backfillCursor: 3n,
        liveCursor: 5n,
        deferred: 0n,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        mode: 'backfilling',
        target: 2n,
        backfillCursor: 4n,
        liveCursor: 1n,
        deferred: 0n,
      }),
    ).toEqual(['NoDoubleApply', 'BackfillWithinTarget']);

    expect(
      violatedInvariants(model, {
        mode: 'live',
        target: 3n,
        backfillCursor: 1n,
        liveCursor: 1n,
        deferred: -1n,
      }),
    ).toEqual([
      'NoDoubleApply',
      'CursorMonotonic',
      'HandoffConsistent',
      'CursorsNonNegative',
    ]);
  });
});
