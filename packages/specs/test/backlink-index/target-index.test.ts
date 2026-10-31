import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, verifySpec } from '@quint-machine/core/testing';
import definitionJson from '../../src/backlink-index/target-index.model.generated.json';

// Spec-only verification for backlink-index's target-keyed index update: a
// fresh (target, source) reference adds an entry, a duplicate never grows the
// index, and a retraction removes one entry. The reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const count = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);
const flag = (state: QuintModelValue, field: string) => Boolean(state[field]);

describe('backlink target index: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('backlink_target_index');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'EntriesNonNegative',
      'ObservedNonNegative',
      'DuplicatesNonNegative',
      'RemovedNonNegative',
      'IndexAccountingExact',
      'LastTargetIsReference',
      'LastSourceIsReference',
      'DuplicateNamesPair',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the scenario pool expands offer into one event per reference shape
    expect(events.length).toBeGreaterThan(definition.step.length);
  });
});

describe('backlink target index: invariants hold under exploration', () => {
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

  it('reaches a state with both live entries and retracted entries', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) =>
          BigInt(state['entries'] ?? 0n) > 0n &&
          BigInt(state['removed'] ?? 0n) > 0n,
      ),
    ).toBe(true);
  });
});

describe('backlink target index: dedupe boundaries', () => {
  it('a duplicate reference is counted but never grows the index', () => {
    let state = step([{ _tag: 'offer', scenario: 0n }]);
    expect({
      entries: count(state, 'entries'),
      observed: count(state, 'observed'),
      duplicates: count(state, 'duplicates'),
      lastDup: flag(state, 'lastDup'),
    }).toEqual({
      entries: 1n,
      observed: 1n,
      duplicates: 0n,
      lastDup: false,
    });

    // the exact same (target, source) pair again: a duplicate
    state = model.transition(state, { _tag: 'offer', scenario: 1n });
    expect({
      entries: count(state, 'entries'),
      observed: count(state, 'observed'),
      duplicates: count(state, 'duplicates'),
      lastDup: flag(state, 'lastDup'),
    }).toEqual({
      entries: 1n,
      observed: 2n,
      duplicates: 1n,
      lastDup: true,
    });

    // same source, different target: a fresh entry
    state = model.transition(state, { _tag: 'offer', scenario: 2n });
    expect({
      entries: count(state, 'entries'),
      observed: count(state, 'observed'),
      duplicates: count(state, 'duplicates'),
    }).toEqual({ entries: 2n, observed: 3n, duplicates: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a retraction removes one entry and re-observing it is fresh again', () => {
    let state = step([
      { _tag: 'offer', scenario: 0n },
      { _tag: 'offer', scenario: 1n },
    ]);

    state = model.transition(state, { _tag: 'retract' });
    expect({
      entries: count(state, 'entries'),
      removed: count(state, 'removed'),
      observed: count(state, 'observed'),
      duplicates: count(state, 'duplicates'),
    }).toEqual({ entries: 0n, removed: 1n, observed: 2n, duplicates: 1n });

    // re-observing the retracted pair is fresh again
    state = model.transition(state, { _tag: 'offer', scenario: 0n });
    expect({
      entries: count(state, 'entries'),
      observed: count(state, 'observed'),
    }).toEqual({ entries: 1n, observed: 3n });

    // retracting an empty index is a no-op, never negative
    state = model.transition(state, { _tag: 'retract' });
    state = model.transition(state, { _tag: 'retract' });
    expect({
      entries: count(state, 'entries'),
      removed: count(state, 'removed'),
    }).toEqual({ entries: 0n, removed: 2n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        entries: 0n,
        observed: 5n,
        duplicates: 0n,
        removed: 0n,
        lastTarget: 'none',
        lastSource: 'none',
        lastDup: true,
      }),
    ).toEqual(['IndexAccountingExact', 'DuplicateNamesPair']);
  });
});
