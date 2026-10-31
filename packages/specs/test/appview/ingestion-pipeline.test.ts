import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/appview/ingestion-pipeline.model.generated.json';

// Spec-only verification for the appview ingest -> projection pipeline. The
// reference model IS the spec; no machine implementation is involved. Every
// step is checked for invariant violations, and the pipeline's ordering rules
// get explicit boundary coverage.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const stage = (state: QuintModelValue) => String(state['stage']);
const cursor = (state: QuintModelValue) => BigInt(state['cursor'] ?? 0n);
const buffered = (state: QuintModelValue) => BigInt(state['buffered'] ?? 0n);
const applied = (state: QuintModelValue) => BigInt(state['applied'] ?? 0n);
const projected = (state: QuintModelValue) => BigInt(state['projected'] ?? 0n);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('appview ingestion pipeline: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('appview_ingestion_pipeline');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NoDoubleApply',
      'IndexConsistent',
      'CursorNonNegative',
      'StageValid',
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

describe('appview ingestion pipeline: invariants under exploration', () => {
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

  it('the canonical cursor never decreases and no step breaks an invariant', () => {
    // `init` resets the machine, so it is excluded from a monotonicity check
    const withoutInit = events.filter((event) => event._tag !== 'init');
    const indices = [...Array(500).keys()].map(
      (i) => (i * 37 + 11) % withoutInit.length,
    );
    let state = model.initial;
    let previous = cursor(state);
    for (const index of indices) {
      const event = withoutInit[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      const next = cursor(state);
      expect(next >= previous).toBe(true);
      expect(violatedInvariants(model, state)).toEqual([]);
      previous = next;
    }
  });
});

describe('appview ingestion pipeline: boundary behavior', () => {
  it('applies one buffered record at a time and projects behind it', () => {
    let state = step([{ _tag: 'start' }]);
    expect(stage(state)).toBe('receiving');

    // in-order delivery buffers; apply commits exactly one record
    state = model.transition(state, { _tag: 'receive', delta: 1n });
    expect({ stage: stage(state), buffered: buffered(state) }).toEqual({
      stage: 'applying',
      buffered: 1n,
    });

    state = model.transition(state, { _tag: 'apply' });
    expect({
      stage: stage(state),
      cursor: cursor(state),
      applied: applied(state),
      projected: projected(state),
    }).toEqual({
      stage: 'projecting',
      cursor: 1n,
      applied: 1n,
      projected: 0n,
    });

    state = model.transition(state, { _tag: 'project' });
    expect({ stage: stage(state), projected: projected(state) }).toEqual({
      stage: 'receiving',
      projected: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('stale and duplicate deliveries are ignored entirely', () => {
    let state = step([{ _tag: 'start' }]);

    state = model.transition(state, { _tag: 'receive', delta: 0n });
    expect({
      stage: stage(state),
      buffered: buffered(state),
      cursor: cursor(state),
    }).toEqual({ stage: 'receiving', buffered: 0n, cursor: 0n });

    state = model.transition(state, { _tag: 'receive', delta: -1n });
    expect({ stage: stage(state), buffered: buffered(state) }).toEqual({
      stage: 'receiving',
      buffered: 0n,
    });
  });

  it('a forward gap blocks the pipeline without advancing the cursor', () => {
    let state = step([{ _tag: 'start' }]);

    state = model.transition(state, { _tag: 'receive', delta: 5n });
    expect({
      stage: stage(state),
      cursor: cursor(state),
      applied: applied(state),
    }).toEqual({ stage: 'blocked', cursor: 0n, applied: 0n });

    // while blocked, further deliveries are ignored
    state = model.transition(state, { _tag: 'receive', delta: 1n });
    expect({ stage: stage(state), buffered: buffered(state) }).toEqual({
      stage: 'blocked',
      buffered: 0n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    expect(
      violatedInvariants(model, {
        stage: 'receiving',
        cursor: 3n,
        buffered: 0n,
        applied: 3n,
        projected: 3n,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        stage: 'zombie',
        cursor: 1n,
        buffered: -1n,
        applied: 3n,
        projected: 4n,
      }),
    ).toEqual(['NoDoubleApply', 'IndexConsistent', 'StageValid']);
  });
});
