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
import definitionJson from '../../src/video/playback-readiness.model.generated.json';

// Spec-only verification for video playback readiness. A viewer request is
// served only while the published playlist is live; before publication and
// after removal it is blocked. The reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const stage = (state: QuintModelValue): string => String(state['stage']);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('video / playback readiness (spec-only)', () => {
  it('declares its invariants and starts processing with no traffic', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StageValid',
      'CountersNonNegative',
      'RequestsBacked',
      'ServedBound',
      'ServedImpliesPublished',
    ]);
    expect(model.initial).toMatchObject({
      stage: 'processing',
      requests: 0n,
      served: 0n,
      blocked: 0n,
    });
  });

  it('derives the event alphabet from the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    expect(tags).toEqual(['publish', 'remove', 'request']);
  });

  it('holds every invariant on every explored and simulated state', () => {
    const exploration = explore(model, { maxDepth: 12, maxStates: 8_000 });
    expect(exploration.states.length).toBeGreaterThan(1);
    expect(exploration.violations).toEqual([]);
    expect(
      exploration.reachable((state) => state['stage'] === 'playable'),
    ).toBe(true);
    expect(exploration.reachable((state) => state['stage'] === 'gone')).toBe(
      true,
    );

    for (const seed of [1, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 250, seed });
      expect(violations).toEqual([]);
    }
  });

  it('boundary: requests are blocked until publish, served, then blocked after removal', () => {
    let state = run([{ _tag: 'request' }]);
    expect(state).toMatchObject({
      stage: 'processing',
      requests: 1n,
      served: 0n,
      blocked: 1n,
    });

    state = model.transition(state, { _tag: 'publish' });
    expect(stage(state)).toBe('playable');

    state = model.transition(state, { _tag: 'request' });
    expect(state).toMatchObject({ requests: 2n, served: 1n, blocked: 1n });

    state = model.transition(state, { _tag: 'remove' });
    expect(stage(state)).toBe('gone');

    state = model.transition(state, { _tag: 'request' });
    expect(state).toMatchObject({ requests: 3n, served: 1n, blocked: 2n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('boundary: removal is terminal and repeated removes are no-ops', () => {
    const gone = run([
      { _tag: 'publish' },
      { _tag: 'request' },
      { _tag: 'remove' },
      { _tag: 'remove' },
    ]);
    expect(stage(gone)).toBe('gone');
    expect(stateKey(model, gone)).toBe(
      stateKey(model, { stage: 'gone', requests: 1n, served: 1n, blocked: 0n }),
    );
    expect(violatedInvariants(model, gone)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    // a served request while still processing is impossible
    expect(
      violatedInvariants(model, {
        stage: 'processing',
        requests: 1n,
        served: 1n,
        blocked: 0n,
      }),
    ).toEqual(['ServedImpliesPublished']);

    expect(
      violatedInvariants(model, {
        stage: 'zombie',
        requests: 1n,
        served: 1n,
        blocked: 1n,
      }),
    ).toEqual(['StageValid', 'RequestsBacked']);

    // more served than requested, and a negative counter
    expect(
      violatedInvariants(model, {
        stage: 'playable',
        requests: 1n,
        served: 2n,
        blocked: -1n,
      }),
    ).toEqual(['CountersNonNegative', 'ServedBound']);
  });
});
