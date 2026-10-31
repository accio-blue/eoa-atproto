import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/appview/read-freshness.model.generated.json';

// Spec-only verification for the appview read/index freshness machine. The
// reference model IS the spec; no machine implementation is involved. Reads
// are served from a projection snapshot that lags the canonical index; the
// boundary cases pin the "never read ahead of the projection" rule.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const indexVersion = (state: QuintModelValue) =>
  BigInt(state['indexVersion'] ?? 0n);
const projectionVersion = (state: QuintModelValue) =>
  BigInt(state['projectionVersion'] ?? 0n);
const servedVersion = (state: QuintModelValue) =>
  BigInt(state['servedVersion'] ?? 0n);
const freshness = (state: QuintModelValue) => String(state['state']);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('appview read freshness: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('appview_read_freshness');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'IndexConsistent',
      'NoReadAheadOfProjection',
      'FreshnessStateValid',
      'FreshnessBound',
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

describe('appview read freshness: invariants under exploration', () => {
  const events = eventsOf(model);

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

  it('the projection never passes the index and reads never pass the projection', () => {
    // `init` resets the machine, so it is excluded from a monotonicity check
    const withoutInit = events.filter((event) => event._tag !== 'init');
    const indices = [...Array(500).keys()].map(
      (i) => (i * 41 + 13) % withoutInit.length,
    );
    let state = model.initial;
    for (const index of indices) {
      const event = withoutInit[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(projectionVersion(state)).toBeLessThanOrEqual(indexVersion(state));
      expect(servedVersion(state)).toBeLessThanOrEqual(
        projectionVersion(state),
      );
      expect(violatedInvariants(model, state)).toEqual([]);
    }
  });
});

describe('appview read freshness: boundary behavior', () => {
  it('the index runs ahead of the projection, which catches up without overshoot', () => {
    let state = step([{ _tag: 'advanceIndex', step: 2n }]);
    expect({
      indexVersion: indexVersion(state),
      projectionVersion: projectionVersion(state),
      freshness: freshness(state),
    }).toEqual({
      indexVersion: 2n,
      projectionVersion: 0n,
      freshness: 'lagging',
    });

    // a read from a not-yet-materialised snapshot is refused
    state = model.transition(state, { _tag: 'read', snapshot: 5n });
    expect(servedVersion(state)).toBe(0n);

    // the projection reaches the index exactly, never past it
    state = model.transition(state, { _tag: 'refreshProjection', step: 2n });
    expect({
      indexVersion: indexVersion(state),
      projectionVersion: projectionVersion(state),
      freshness: freshness(state),
    }).toEqual({
      indexVersion: 2n,
      projectionVersion: 2n,
      freshness: 'fresh',
    });

    // once materialised, the snapshot may be served
    state = model.transition(state, { _tag: 'read', snapshot: 2n });
    expect(servedVersion(state)).toBe(2n);
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    expect(
      violatedInvariants(model, {
        indexVersion: 3n,
        projectionVersion: 2n,
        servedVersion: 1n,
        state: 'lagging',
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        indexVersion: 1n,
        projectionVersion: 3n,
        servedVersion: 5n,
        state: 'fresh',
      }),
    ).toEqual(['IndexConsistent', 'NoReadAheadOfProjection', 'FreshnessBound']);
  });
});
