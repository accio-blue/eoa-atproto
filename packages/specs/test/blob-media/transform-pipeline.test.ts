import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/blob-media/transform-pipeline.model.generated.json';

// Spec-only verification for the blob/media transform + thumbnail pipeline. The
// generated reference model IS the spec; no machine implementation is involved.
// Every declared invariant is checked after every reachable step, and the
// hit/miss/derive/evict boundaries get explicit coverage.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const text = (state: QuintModelValue, field: string): string =>
  String(state[field] ?? '');

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('blob-media / transform pipeline (spec-only)', () => {
  it('declares the pipeline invariants and starts idle with a cold cache', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'PhaseValid',
      'WantedValid',
      'CachedValid',
      'CacheValid',
      'CountersNonNegative',
      'ServedBacked',
      'WarmImpliesDerived',
    ]);
    expect(model.initial).toMatchObject({
      phase: 'idle',
      cache: 'cold',
      cached: 'none',
      derived: 0n,
      hits: 0n,
      served: 0n,
    });
  });

  it('derives the event alphabet from the spec pools', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'request', pick: 'thumb' },
      { _tag: 'request', pick: 'feed' },
      { _tag: 'request', pick: 'full' },
      { _tag: 'derive' },
      { _tag: 'settle' },
      { _tag: 'evict' },
    ]);
  });

  it('holds every invariant on every explored and simulated state', () => {
    const exploration = explore(model, { maxDepth: 6, maxStates: 8_000 });
    expect(exploration.states.length).toBeGreaterThan(1);
    expect(exploration.violations).toEqual([]);
    expect(exploration.reachable((state) => state['cache'] === 'warm')).toBe(
      true,
    );
    expect(
      exploration.reachable((state) => state['phase'] === 'deriving'),
    ).toBe(true);

    for (const seed of [1, 42, 1337]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 200, seed });
      expect(violations).toEqual([]);
    }
  });

  it('boundary: a cold request misses, derives, warms the cache and serves', () => {
    let state = step([{ _tag: 'request', pick: 'thumb' }]);
    expect(state).toMatchObject({
      phase: 'deriving',
      wanted: 'thumb',
      cache: 'cold',
    });

    state = model.transition(state, { _tag: 'derive' });
    expect(state).toMatchObject({
      phase: 'serving',
      cache: 'warm',
      cached: 'thumb',
      derived: 1n,
      hits: 0n,
      served: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('boundary: the warm variant is a hit, another variant misses', () => {
    // warm the cache on `thumb`
    let state = step([
      { _tag: 'request', pick: 'thumb' },
      { _tag: 'derive' },
      { _tag: 'settle' },
    ]);
    expect(text(state, 'cache')).toBe('warm');

    // same variant -> hit, no new derivation
    state = model.transition(state, { _tag: 'request', pick: 'thumb' });
    expect(state).toMatchObject({
      phase: 'serving',
      hits: 1n,
      served: 2n,
      derived: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);

    // different variant while warm -> miss, back to deriving
    const other = model.transition(
      step([
        { _tag: 'request', pick: 'thumb' },
        { _tag: 'derive' },
        { _tag: 'settle' },
      ]),
      { _tag: 'request', pick: 'feed' },
    );
    expect(other).toMatchObject({
      phase: 'deriving',
      wanted: 'feed',
      hits: 0n,
    });
  });

  it('boundary: eviction empties the cache but keeps the counters', () => {
    const warm = step([
      { _tag: 'request', pick: 'full' },
      { _tag: 'derive' },
      { _tag: 'settle' },
    ]);
    const evicted = model.transition(warm, { _tag: 'evict' });
    expect(evicted).toMatchObject({
      cache: 'cold',
      cached: 'none',
      derived: 1n,
      served: 1n,
    });
    expect(violatedInvariants(model, evicted)).toEqual([]);

    // deriving again re-warms on the newly requested variant
    const again = model.transition(
      model.transition(evicted, { _tag: 'request', pick: 'feed' }),
      { _tag: 'derive' },
    );
    expect(again).toMatchObject({
      cache: 'warm',
      cached: 'feed',
      derived: 2n,
      served: 2n,
    });
    expect(violatedInvariants(model, again)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    expect(
      violatedInvariants(model, {
        phase: 'idle',
        wanted: 'none',
        cached: 'none',
        cache: 'warm',
        derived: 0n,
        hits: 0n,
        served: 0n,
      }),
    ).toEqual(['WarmImpliesDerived']);

    expect(
      violatedInvariants(model, {
        phase: 'bogus',
        wanted: 'thumb',
        cached: 'thumb',
        cache: 'warm',
        derived: 1n,
        hits: 0n,
        served: 3n,
      }),
    ).toEqual(['PhaseValid', 'ServedBacked']);
  });
});
