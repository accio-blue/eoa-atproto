import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/space-host/space-write-log.model.generated.json';

// Spec-only verification of the Space host per-space write log: a writer
// snapshots the head, a competing writer races it, and a stale append must
// conflict without merging.

const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('space-host: per-space write log CAS (spec-only)', () => {
  it('declares the CAS invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NoMergeOnConflict',
      'BaseNeverAhead',
      'HeadNonNegative',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'begin' },
      { _tag: 'appendOp' },
      { _tag: 'race', delta: 1n },
      { _tag: 'race', delta: 2n },
    ]);
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 5000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['outcome'] === 'committed')).toBe(
      true,
    );
    expect(report.reachable((state) => state['outcome'] === 'conflict')).toBe(
      true,
    );
    expect(
      report.reachable((state) => state['base'] !== state['logHead']),
    ).toBe(true);
  });

  it('a raced writer conflicts and does not merge into the log', () => {
    let state = model.initial;
    state = model.transition(state, { _tag: 'begin' });
    expect(state).toMatchObject({ logHead: 0n, base: 0n, outcome: 'begin' });

    // a competing writer advances the shared head behind our back
    state = model.transition(state, { _tag: 'race', delta: 2n });
    expect(state).toMatchObject({ logHead: 2n, base: 0n });

    const conflicted = model.transition(state, { _tag: 'appendOp' });
    expect(conflicted).toMatchObject({
      logHead: 2n,
      base: 0n,
      outcome: 'conflict',
    });
    expect(violatedInvariants(model, conflicted)).toEqual([]);

    // re-snapshot then append with CAS succeeds by exactly one version
    state = model.transition(conflicted, { _tag: 'begin' });
    const committed = model.transition(state, { _tag: 'appendOp' });
    expect(committed).toMatchObject({
      logHead: 3n,
      base: 2n,
      outcome: 'committed',
    });
    expect(violatedInvariants(model, committed)).toEqual([]);

    // a merge into the shared head breaks the commit/head relation, by name
    expect(violatedInvariants(model, { ...committed, logHead: 5n })).toContain(
      'NoMergeOnConflict',
    );
  });
});
