import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, verifySpec } from '@quint-machine/core/testing';
import definitionJson from '../../src/backlink-index/backfill-live.model.generated.json';

// Spec-only verification for backlink-index backfill-vs-live reconciliation:
// history (PDS crawl) and the live relay subscription reconcile around one
// ordinal cursor, the index holds each ordinal once, and a live delivery the
// backfill already covers is never double-indexed. The reference model IS the
// spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const mode = (state: QuintModelValue) => String(state['mode']);
const count = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('backlink backfill-live: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('backlink_backfill_live');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NoDoubleIndex',
      'BackfillWithinTarget',
      'CursorMonotonic',
      'HandoffConsistent',
      'EntriesCoverHighest',
      'CursorsNonNegative',
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

describe('backlink backfill-live: invariants hold under exploration', () => {
  it('no invariant fails on exploration or seeded random walks', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(() =>
        verifySpec(model, {
          maxDepth: 8,
          maxStates: 4000,
          runs: 1,
          maxSteps: 200,
          seed,
        }),
      ).not.toThrow();
    }
  });

  it('reaches a live index that drained a deferred delivery', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) =>
          state['mode'] === 'live' &&
          BigInt(state['liveCursor'] ?? 0n) > BigInt(state['target'] ?? 0n) &&
          BigInt(state['entries'] ?? 0n) > 0n,
      ),
    ).toBe(true);
  });
});

describe('backlink backfill-live: reconciliation boundaries', () => {
  it('a live delivery beyond the backfill point is deferred, never indexed', () => {
    let state = step([{ _tag: 'startBackfill', startTarget: 3n }]);
    expect({ mode: mode(state), target: count(state, 'target') }).toEqual({
      mode: 'backfilling',
      target: 3n,
    });

    // seq 5 is past the target: held, not indexed
    state = model.transition(state, { _tag: 'liveEvent', seq: 5n });
    expect({
      mode: mode(state),
      liveCursor: count(state, 'liveCursor'),
      deferred: count(state, 'deferred'),
      entries: count(state, 'entries'),
    }).toEqual({
      mode: 'backfilling',
      liveCursor: 0n,
      deferred: 1n,
      entries: 0n,
    });

    // seq 2 is covered by history: ignored, not indexed
    state = model.transition(state, { _tag: 'liveEvent', seq: 2n });
    expect({
      liveCursor: count(state, 'liveCursor'),
      deferred: count(state, 'deferred'),
      entries: count(state, 'entries'),
    }).toEqual({ liveCursor: 0n, deferred: 1n, entries: 0n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a stale backfill page is ignored and the target hands over to live', () => {
    let state = step([{ _tag: 'startBackfill', startTarget: 3n }]);

    state = model.transition(state, { _tag: 'backfillPage', seq: 1n });
    expect({
      mode: mode(state),
      backfillCursor: count(state, 'backfillCursor'),
      entries: count(state, 'entries'),
    }).toEqual({ mode: 'backfilling', backfillCursor: 1n, entries: 1n });

    // stale page (already covered) is ignored
    state = model.transition(state, { _tag: 'backfillPage', seq: 0n });
    expect({
      mode: mode(state),
      backfillCursor: count(state, 'backfillCursor'),
      entries: count(state, 'entries'),
    }).toEqual({ mode: 'backfilling', backfillCursor: 1n, entries: 1n });

    // page at the target hands over without jumping past it
    state = model.transition(state, { _tag: 'backfillPage', seq: 3n });
    expect({
      mode: mode(state),
      backfillCursor: count(state, 'backfillCursor'),
      liveCursor: count(state, 'liveCursor'),
      entries: count(state, 'entries'),
    }).toEqual({
      mode: 'live',
      backfillCursor: 3n,
      liveCursor: 3n,
      entries: 3n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('deferred deliveries drain in order after handover', () => {
    let state = step([
      { _tag: 'startBackfill', startTarget: 3n },
      { _tag: 'liveEvent', seq: 5n },
      { _tag: 'backfillPage', seq: 3n },
    ]);
    expect({
      mode: mode(state),
      deferred: count(state, 'deferred'),
      liveCursor: count(state, 'liveCursor'),
      entries: count(state, 'entries'),
    }).toEqual({
      mode: 'live',
      deferred: 1n,
      liveCursor: 3n,
      entries: 3n,
    });

    // a live delivery past the target applies and is indexed once
    state = model.transition(state, { _tag: 'liveEvent', seq: 6n });
    expect({
      liveCursor: count(state, 'liveCursor'),
      entries: count(state, 'entries'),
    }).toEqual({ liveCursor: 6n, entries: 6n });

    // a stale live delivery is ignored
    state = model.transition(state, { _tag: 'liveEvent', seq: 3n });
    expect(count(state, 'liveCursor')).toBe(6n);

    state = model.transition(state, { _tag: 'drainDeferred' });
    expect({
      deferred: count(state, 'deferred'),
      liveCursor: count(state, 'liveCursor'),
      entries: count(state, 'entries'),
    }).toEqual({ deferred: 0n, liveCursor: 7n, entries: 7n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        mode: 'live',
        target: 3n,
        backfillCursor: 1n,
        liveCursor: 1n,
        deferred: -1n,
        entries: 1n,
      }),
    ).toEqual([
      'NoDoubleIndex',
      'CursorMonotonic',
      'HandoffConsistent',
      'CursorsNonNegative',
    ]);
  });
});
