import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, verifySpec } from '@quint-machine/core/testing';
import definitionJson from '../../src/search/tombstone-index.model.generated.json';

// Spec-only verification for search's delete tombstones: a delete removes a
// document from the index, a stale re-ingest never resurrects it, and only a
// strictly newer revision re-indexes it. The reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const entry = (state: QuintModelValue) => String(state['entry']);
const decision = (state: QuintModelValue) => String(state['decision']);
const revision = (state: QuintModelValue) => BigInt(state['revision'] ?? 0n);

describe('search tombstone-index: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('search_tombstone_index');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'EntryValid',
      'DecisionValid',
      'DeletedNeverPresent',
      'NoDecisionWithoutQuery',
      'RevisionNonNegative',
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

describe('search tombstone-index: invariants hold under exploration', () => {
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

  it('reaches a deleted entry that stays absent from query results', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) =>
          state['entry'] === 'deleted' && state['decision'] === 'absent',
      ),
    ).toBe(true);
  });
});

describe('search tombstone-index: tombstone boundaries', () => {
  it('a delete hides the document and a stale re-ingest never resurrects it', () => {
    let state = step([{ _tag: 'ingest', version: 3n }]);
    expect({ entry: entry(state), revision: revision(state) }).toEqual({
      entry: 'indexed',
      revision: 3n,
    });

    state = model.transition(state, { _tag: 'deleteDoc' });
    state = model.transition(state, { _tag: 'runQuery' });
    expect({ entry: entry(state), decision: decision(state) }).toEqual({
      entry: 'deleted',
      decision: 'absent',
    });

    // stale re-ingest (already seen revision): stays deleted
    state = model.transition(state, { _tag: 'ingest', version: 1n });
    state = model.transition(state, { _tag: 'runQuery' });
    expect({ entry: entry(state), decision: decision(state) }).toEqual({
      entry: 'deleted',
      decision: 'absent',
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a strictly newer revision re-indexes a deleted document', () => {
    let state = step([{ _tag: 'ingest', version: 1n }, { _tag: 'deleteDoc' }]);
    expect(entry(state)).toBe('deleted');

    state = model.transition(state, { _tag: 'ingest', version: 2n });
    state = model.transition(state, { _tag: 'runQuery' });
    expect({ entry: entry(state), decision: decision(state) }).toEqual({
      entry: 'indexed',
      decision: 'present',
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    // a deleted entry surfacing as present
    expect(
      violatedInvariants(model, {
        entry: 'deleted',
        revision: 2n,
        requested: true,
        decision: 'present',
      }),
    ).toEqual(['DeletedNeverPresent']);

    // a decision with no query behind it
    expect(
      violatedInvariants(model, {
        entry: 'none',
        revision: 0n,
        requested: false,
        decision: 'absent',
      }),
    ).toEqual(['NoDecisionWithoutQuery']);
  });
});
