import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/pds/repo-write.model.generated.json';

const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('pds repo write (spec-only)', () => {
  it('generated model carries the spec-declared invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'CommitNonNegative',
      'RecordInRange',
      'StagedInRange',
      'PhaseValid',
      'ValidatedStaged',
      'DirtyOnlyWhenValidated',
    ]);
  });

  it('invariants hold across seeded random event sequences', () => {
    const report = simulate(model, {
      runs: 300,
      maxSteps: 40,
      seed: 0x5eed_0001,
    });
    expect(report.violations).toEqual([]);
  });

  it('invariants hold across the bounded exhaustive event space', () => {
    const report = explore(model, { maxDepth: 5, maxStates: 100_000 });
    expect(report.violations).toEqual([]);
  });

  it('invariants have teeth', () => {
    expect(
      violatedInvariants(model, {
        phase: 'idle',
        commit: 0n,
        record: -1n,
        staged: -1n,
        mstDirty: false,
      }),
    ).toEqual([]);
    expect(
      violatedInvariants(model, {
        phase: 'idle',
        commit: 0n,
        record: 5n,
        staged: -2n,
        mstDirty: true,
      }),
    ).toEqual(['RecordInRange', 'StagedInRange', 'DirtyOnlyWhenValidated']);
  });

  it('boundary: a stale observed commit conflicts and leaves the repo untouched', () => {
    const after = model.transition(model.initial, {
      _tag: 'submit',
      seen: 3n,
    });
    expect(after).toMatchObject({
      phase: 'conflict',
      commit: 0n,
      record: -1n,
      staged: -1n,
      mstDirty: false,
    });
    expect(violatedInvariants(model, after)).toEqual([]);
  });

  it('boundary: a fresh CAS validates, commits, and advances the commit', () => {
    const validated = model.transition(model.initial, {
      _tag: 'submit',
      seen: 0n,
    });
    expect(validated).toMatchObject({
      phase: 'validated',
      commit: 0n,
      staged: 1n,
      mstDirty: true,
    });
    expect(violatedInvariants(model, validated)).toEqual([]);

    const committed = model.transition(validated, { _tag: 'commitWrite' });
    expect(committed).toMatchObject({
      phase: 'committed',
      commit: 1n,
      record: 1n,
      staged: 1n,
      mstDirty: false,
    });
    expect(violatedInvariants(model, committed)).toEqual([]);
  });

  it('boundary: omitting swapCommit (seen -1) always applies', () => {
    const validated = model.transition(model.initial, {
      _tag: 'submit',
      seen: -1n,
    });
    expect(validated).toMatchObject({ phase: 'validated' });
    const committed = model.transition(validated, { _tag: 'commitWrite' });
    expect(committed).toMatchObject({
      phase: 'committed',
      commit: 1n,
      record: 1n,
    });
  });

  it('boundary: reload clears a conflict without rewinding the commit', () => {
    const conflicted = model.transition(model.initial, {
      _tag: 'submit',
      seen: 4n,
    });
    const reloaded = model.transition(conflicted, { _tag: 'reload' });
    expect(reloaded).toMatchObject({
      phase: 'idle',
      commit: 0n,
      record: -1n,
      staged: -1n,
    });
    expect(violatedInvariants(model, reloaded)).toEqual([]);
  });
});
