import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, verifySpec } from '@quint-machine/core/testing';
import definitionJson from '../../src/search/ingest-index.model.generated.json';

// Spec-only verification for search's ingest -> index pipeline: the live
// firehose drives an ordinal cursor, a forward gap blocks, stale deliveries
// are ignored, and deletes tombstone documents out of the queryable set. The
// reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const field = (state: QuintModelValue, name: string) => String(state[name]);
const count = (state: QuintModelValue, name: string) =>
  BigInt(state[name] ?? 0n);

describe('search ingest-index: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('search_ingest_index');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'PhaseValid',
      'CursorNonNegative',
      'BufferNonNegative',
      'IndexedAssetsMatchCursor',
      'TombstonesNonNegative',
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

describe('search ingest-index: invariants hold under exploration', () => {
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

  it('reaches an index that both indexed and tombstoned a document', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) =>
          BigInt(state['docs'] ?? 0n) > 0n &&
          BigInt(state['tombstones'] ?? 0n) > 0n,
      ),
    ).toBe(true);
  });
});

describe('search ingest-index: ingest boundaries', () => {
  it('a forward gap blocks until it closes and a stale delivery is ignored', () => {
    let state = step([{ _tag: 'startStream' }]);
    expect(field(state, 'phase')).toBe('streaming');

    // next in order: buffered
    state = model.transition(state, { _tag: 'receive', delta: 1n });
    expect({
      phase: field(state, 'phase'),
      buffer: count(state, 'buffer'),
    }).toEqual({ phase: 'streaming', buffer: 1n });

    // forward gap: blocked
    state = model.transition(state, { _tag: 'receive', delta: 5n });
    expect({
      phase: field(state, 'phase'),
      buffer: count(state, 'buffer'),
    }).toEqual({ phase: 'blocked', buffer: 1n });

    // stale/duplicate while blocked: ignored
    state = model.transition(state, { _tag: 'receive', delta: 0n });
    expect({
      phase: field(state, 'phase'),
      buffer: count(state, 'buffer'),
    }).toEqual({ phase: 'blocked', buffer: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('indexing advances the cursor by one and a delete tombstones the doc', () => {
    let state = step([
      { _tag: 'startStream' },
      { _tag: 'receive', delta: 1n },
      { _tag: 'indexRecord' },
    ]);
    expect({
      cursor: count(state, 'cursor'),
      docs: count(state, 'docs'),
      buffer: count(state, 'buffer'),
    }).toEqual({ cursor: 1n, docs: 1n, buffer: 0n });

    // deleting moves the document from live to tombstoned, cursor unchanged
    state = model.transition(state, { _tag: 'deleteDoc' });
    expect({
      cursor: count(state, 'cursor'),
      docs: count(state, 'docs'),
      tombstones: count(state, 'tombstones'),
    }).toEqual({ cursor: 1n, docs: 0n, tombstones: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    // two documents held from a single cursor advance
    expect(
      violatedInvariants(model, {
        phase: 'streaming',
        cursor: 1n,
        buffer: 0n,
        docs: 1n,
        tombstones: 1n,
      }),
    ).toEqual(['IndexedAssetsMatchCursor']);

    // an invalid phase
    expect(
      violatedInvariants(model, {
        phase: 'paused',
        cursor: 0n,
        buffer: 0n,
        docs: 0n,
        tombstones: 0n,
      }),
    ).toEqual(['PhaseValid']);
  });
});
