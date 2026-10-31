import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/pds/blob-upload.model.generated.json';

const model = makeReferenceModel(decodeDefinition(definitionJson));

const begin = () => model.transition(model.initial, { _tag: 'begin' });

describe('pds blob upload (spec-only)', () => {
  it('generated model carries the spec-declared invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'PhaseValid',
      'LimitPositive',
      'BytesInRange',
      'UploadedNonEmpty',
      'FailedDiscardsBytes',
    ]);
  });

  it('invariants hold across seeded random event sequences', () => {
    const report = simulate(model, {
      runs: 300,
      maxSteps: 40,
      seed: 0xb10b_0001,
    });
    expect(report.violations).toEqual([]);
  });

  it('invariants hold across the bounded exhaustive event space', () => {
    const report = explore(model, { maxDepth: 5, maxStates: 100_000 });
    expect(report.violations).toEqual([]);
  });

  it('invariants have teeth', () => {
    expect(
      violatedInvariants(model, { phase: 'empty', bytes: 0n, limit: 1024n }),
    ).toEqual([]);
    expect(
      violatedInvariants(model, {
        phase: 'uploaded',
        bytes: 0n,
        limit: -1n,
      }),
    ).toEqual(['LimitPositive', 'BytesInRange', 'UploadedNonEmpty']);
  });

  it('boundary: a chunk landing exactly on the limit is accepted', () => {
    const uploaded = model.transition(begin(), {
      _tag: 'appendChunk',
      chunk: 1024n,
    });
    expect(uploaded).toMatchObject({ phase: 'uploading', bytes: 1024n });
    expect(violatedInvariants(model, uploaded)).toEqual([]);
  });

  it('boundary: a chunk over the limit fails the session and discards the bytes', () => {
    const full = model.transition(begin(), {
      _tag: 'appendChunk',
      chunk: 1024n,
    });
    const failed = model.transition(full, {
      _tag: 'appendChunk',
      chunk: 128n,
    });
    expect(failed).toMatchObject({ phase: 'failed', bytes: 0n });
    expect(violatedInvariants(model, failed)).toEqual([]);

    // a failed session accepts no more chunks and cannot be finalized
    const appended = model.transition(failed, {
      _tag: 'appendChunk',
      chunk: 0n,
    });
    expect(appended).toMatchObject({ phase: 'failed', bytes: 0n });
    const finished = model.transition(appended, { _tag: 'finish' });
    expect(finished).toMatchObject({ phase: 'failed', bytes: 0n });
  });

  it('boundary: an empty upload cannot be finalized, discard returns to empty', () => {
    const empty = model.transition(begin(), { _tag: 'finish' });
    expect(empty).toMatchObject({ phase: 'uploading', bytes: 0n });
    const discarded = model.transition(empty, { _tag: 'discard' });
    expect(discarded).toMatchObject({ phase: 'empty', bytes: 0n });
    expect(violatedInvariants(model, discarded)).toEqual([]);
  });
});
