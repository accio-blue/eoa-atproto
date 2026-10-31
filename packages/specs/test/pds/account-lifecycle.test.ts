import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/pds/account-lifecycle.model.generated.json';

const model = makeReferenceModel(decodeDefinition(definitionJson));

const create = (availability: 'free' | 'taken') =>
  model.transition(model.initial, { _tag: 'create', availability });

describe('pds account lifecycle (spec-only)', () => {
  it('generated model carries the spec-declared invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StatusValid',
      'CreatedReservesHandle',
      'ActiveReservesHandle',
      'SuspendedReservesHandle',
      'AbsentHasNoHandle',
      'DeletedReleasesHandle',
    ]);
  });

  it('invariants hold across seeded random event sequences', () => {
    const report = simulate(model, {
      runs: 300,
      maxSteps: 40,
      seed: 0xacc0_0001,
    });
    expect(report.violations).toEqual([]);
  });

  it('invariants hold across the bounded exhaustive event space', () => {
    const report = explore(model, { maxDepth: 5, maxStates: 100_000 });
    expect(report.violations).toEqual([]);
  });

  it('invariants have teeth', () => {
    expect(
      violatedInvariants(model, { status: 'absent', handleReserved: false }),
    ).toEqual([]);
    expect(
      violatedInvariants(model, { status: 'bogus', handleReserved: true }),
    ).toEqual(['StatusValid']);
    expect(
      violatedInvariants(model, { status: 'deleted', handleReserved: true }),
    ).toEqual(['DeletedReleasesHandle']);
  });

  it('boundary: a taken handle rejects registration', () => {
    const rejected = create('taken');
    expect(rejected).toMatchObject({ status: 'absent', handleReserved: false });
    expect(violatedInvariants(model, rejected)).toEqual([]);
  });

  it('boundary: a free handle registers, activates, and delete releases it', () => {
    const created = create('free');
    expect(created).toMatchObject({ status: 'created', handleReserved: true });

    const active = model.transition(created, { _tag: 'activate' });
    expect(active).toMatchObject({ status: 'active', handleReserved: true });

    const suspended = model.transition(active, { _tag: 'suspend' });
    expect(suspended).toMatchObject({
      status: 'suspended',
      handleReserved: true,
    });

    const reinstated = model.transition(suspended, { _tag: 'reinstate' });
    expect(reinstated).toMatchObject({
      status: 'active',
      handleReserved: true,
    });

    const deleted = model.transition(reinstated, { _tag: 'deleteAccount' });
    expect(deleted).toMatchObject({ status: 'deleted', handleReserved: false });
    expect(violatedInvariants(model, deleted)).toEqual([]);
  });

  it('boundary: a deleted account is terminal', () => {
    const deleted = model.transition(create('free'), { _tag: 'activate' });
    const gone = model.transition(deleted, { _tag: 'deleteAccount' });
    const resurrected = model.transition(gone, {
      _tag: 'create',
      availability: 'free',
    });
    expect(resurrected).toMatchObject({
      status: 'deleted',
      handleReserved: false,
    });
  });
});
