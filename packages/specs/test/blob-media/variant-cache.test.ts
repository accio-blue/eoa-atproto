import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/blob-media/variant-cache.model.generated.json';

// Spec-only verification for the blob/media per-variant derivative cache. The
// generated reference model IS the spec; the two-slot LRU bound and its
// eviction accounting are checked under exploration and pinned at the edges.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('blob-media / variant cache (LRU, two slots)', () => {
  it('declares the cache invariants and starts empty', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NewestValid',
      'OlderValid',
      'SlotsDistinct',
      'OlderImpliesNewest',
      'CountersNonNegative',
      'PlacementAccounting',
    ]);
    expect(model.initial).toMatchObject({
      newest: 'none',
      older: 'none',
      placed: 0n,
      evicted: 0n,
      refreshed: 0n,
    });
  });

  it('derives the event alphabet from the spec pools', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'touch', pick: 'thumb' },
      { _tag: 'touch', pick: 'feed' },
      { _tag: 'touch', pick: 'full' },
      { _tag: 'expire' },
    ]);
  });

  it('holds every invariant on every explored and simulated state', () => {
    const exploration = explore(model, { maxDepth: 8, maxStates: 20_000 });
    expect(exploration.states.length).toBeGreaterThan(1);
    expect(exploration.violations).toEqual([]);
    expect(exploration.reachable((state) => state['older'] !== 'none')).toBe(
      true,
    );
    expect(exploration.reachable((state) => state['evicted'] !== 0n)).toBe(
      true,
    );

    for (const seed of [3, 21, 512]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 200, seed });
      expect(violations).toEqual([]);
    }
  });

  it('boundary: two free slots fill without eviction; a third variant evicts the LRU', () => {
    let state = model.transition(model.initial, {
      _tag: 'touch',
      pick: 'thumb',
    });
    expect(state).toMatchObject({
      newest: 'thumb',
      older: 'none',
      placed: 1n,
      evicted: 0n,
    });

    state = model.transition(state, { _tag: 'touch', pick: 'feed' });
    expect(state).toMatchObject({
      newest: 'feed',
      older: 'thumb',
      placed: 2n,
      evicted: 0n,
    });

    // both slots full: inserting `full` evicts the least-recently-used `thumb`
    state = model.transition(state, { _tag: 'touch', pick: 'full' });
    expect(state).toMatchObject({
      newest: 'full',
      older: 'feed',
      placed: 3n,
      evicted: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('boundary: touching the older slot promotes it without an insert', () => {
    const state = step([
      { _tag: 'touch', pick: 'thumb' },
      { _tag: 'touch', pick: 'feed' },
    ]);
    const promoted = model.transition(state, { _tag: 'touch', pick: 'thumb' });
    expect(promoted).toMatchObject({
      newest: 'thumb',
      older: 'feed',
      placed: 2n,
      evicted: 0n,
      refreshed: 1n,
    });
    expect(violatedInvariants(model, promoted)).toEqual([]);
  });

  it('boundary: expiry drops the LRU entry and accounts for it', () => {
    const state = step([
      { _tag: 'touch', pick: 'thumb' },
      { _tag: 'touch', pick: 'feed' },
    ]);
    const expired = model.transition(state, { _tag: 'expire' });
    expect(expired).toMatchObject({
      newest: 'feed',
      older: 'none',
      placed: 2n,
      evicted: 1n,
    });
    expect(violatedInvariants(model, expired)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    // the two slots must never name the same variant
    expect(
      violatedInvariants(model, {
        newest: 'thumb',
        older: 'thumb',
        placed: 2n,
        evicted: 0n,
        refreshed: 0n,
      }),
    ).toEqual(['SlotsDistinct']);

    // placed slots must be occupied now or since evicted
    expect(
      violatedInvariants(model, {
        newest: 'thumb',
        older: 'feed',
        placed: 1n,
        evicted: 0n,
        refreshed: 0n,
      }),
    ).toEqual(['PlacementAccounting']);

    // an `older` slot cannot exist without a `newest` slot
    expect(
      violatedInvariants(model, {
        newest: 'none',
        older: 'thumb',
        placed: 1n,
        evicted: 0n,
        refreshed: 0n,
      }),
    ).toEqual(['OlderImpliesNewest']);
  });
});
