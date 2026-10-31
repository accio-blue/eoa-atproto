import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/blob-media/media-routing.model.generated.json';

// Spec-only verification for blob/media request routing. The generated
// reference model IS the spec: a request is resolved to cache / derive / origin
// / reject, delivered exactly once, and every declared invariant is checked
// after every reachable step.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('blob-media / media-request routing (spec-only)', () => {
  it('declares the routing invariants and starts idle with no route', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'PhaseValid',
      'RouteValid',
      'CountersNonNegative',
      'ResolvedHasRoute',
      'IdleHasNoRoute',
      'ServedLocally',
      'RejectOnlyUnknown',
    ]);
    expect(model.initial).toMatchObject({
      phase: 'idle',
      requested: 'none',
      availability: 'none',
      route: 'none',
      served: 0n,
      redirected: 0n,
      rejected: 0n,
    });
  });

  it('derives the event alphabet from the spec pools', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'accept', pick: 'thumb' },
      { _tag: 'accept', pick: 'feed' },
      { _tag: 'accept', pick: 'full' },
      { _tag: 'accept', pick: 'unknown' },
      { _tag: 'probe', found: 'hot' },
      { _tag: 'probe', found: 'cold' },
      { _tag: 'probe', found: 'remote' },
      { _tag: 'deliver' },
      { _tag: 'reset' },
    ]);
  });

  it('holds every invariant on every explored and simulated state', () => {
    const exploration = explore(model, { maxDepth: 7, maxStates: 20_000 });
    expect(exploration.states.length).toBeGreaterThan(1);
    expect(exploration.violations).toEqual([]);
    expect(exploration.reachable((state) => state['route'] === 'cache')).toBe(
      true,
    );
    expect(exploration.reachable((state) => state['route'] === 'reject')).toBe(
      true,
    );

    for (const seed of [5, 77, 9001]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 200, seed });
      expect(violations).toEqual([]);
    }
  });

  it('boundary: an unknown variant is rejected', () => {
    let state = model.transition(model.initial, {
      _tag: 'accept',
      pick: 'unknown',
    });
    expect(state).toMatchObject({ phase: 'routing', requested: 'unknown' });

    state = model.transition(state, { _tag: 'probe', found: 'hot' });
    expect(state).toMatchObject({ phase: 'resolved', route: 'reject' });

    state = model.transition(state, { _tag: 'deliver' });
    expect(state).toMatchObject({
      phase: 'rejected',
      rejected: 1n,
      served: 0n,
      redirected: 0n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('boundary: hot cache serves locally, cold derives, remote redirects', () => {
    const hot = step([
      { _tag: 'accept', pick: 'thumb' },
      { _tag: 'probe', found: 'hot' },
      { _tag: 'deliver' },
    ]);
    expect(hot).toMatchObject({
      phase: 'served',
      route: 'cache',
      served: 1n,
      redirected: 0n,
    });
    expect(violatedInvariants(model, hot)).toEqual([]);

    const cold = step([
      { _tag: 'accept', pick: 'feed' },
      { _tag: 'probe', found: 'cold' },
      { _tag: 'deliver' },
    ]);
    expect(cold).toMatchObject({
      phase: 'served',
      route: 'derive',
      served: 1n,
    });
    expect(violatedInvariants(model, cold)).toEqual([]);

    const remote = step([
      { _tag: 'accept', pick: 'full' },
      { _tag: 'probe', found: 'remote' },
      { _tag: 'deliver' },
    ]);
    expect(remote).toMatchObject({
      phase: 'redirected',
      route: 'origin',
      redirected: 1n,
      served: 0n,
    });
    expect(violatedInvariants(model, remote)).toEqual([]);
  });

  it('boundary: reset returns to idle without disturbing the counters', () => {
    const served = step([
      { _tag: 'accept', pick: 'thumb' },
      { _tag: 'probe', found: 'hot' },
      { _tag: 'deliver' },
    ]);
    const reset = model.transition(served, { _tag: 'reset' });
    expect(reset).toMatchObject({
      phase: 'idle',
      requested: 'none',
      route: 'none',
      served: 1n,
    });
    expect(violatedInvariants(model, reset)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    // a known variant is never rejected
    expect(
      violatedInvariants(model, {
        phase: 'rejected',
        requested: 'thumb',
        availability: 'hot',
        route: 'reject',
        served: 0n,
        redirected: 0n,
        rejected: 1n,
      }),
    ).toEqual(['RejectOnlyUnknown']);

    // an origin redirect is never counted as a served response
    expect(
      violatedInvariants(model, {
        phase: 'served',
        requested: 'thumb',
        availability: 'remote',
        route: 'origin',
        served: 1n,
        redirected: 0n,
        rejected: 0n,
      }),
    ).toEqual(['ServedLocally']);

    // a resolved request must carry a route
    expect(
      violatedInvariants(model, {
        phase: 'resolved',
        requested: 'thumb',
        availability: 'none',
        route: 'none',
        served: 0n,
        redirected: 0n,
        rejected: 0n,
      }),
    ).toEqual(['ResolvedHasRoute']);

    // an idle request must not carry a route
    expect(
      violatedInvariants(model, {
        phase: 'idle',
        requested: 'thumb',
        availability: 'hot',
        route: 'cache',
        served: 0n,
        redirected: 0n,
        rejected: 0n,
      }),
    ).toEqual(['IdleHasNoRoute']);
  });
});
