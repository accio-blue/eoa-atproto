import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/space-host/revocation-log.model.generated.json';

// Spec-only verification of Space host revocation as an append-only,
// forward-only log: records may arrive out of order, but the revocation pointer
// only ever advances and can never name a future epoch.

const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('space-host: revocation log (spec-only)', () => {
  it('declares the forward-only invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'RevocationForwardOnly',
      'RevokedStaysRevoked',
      'EpochNonNegative',
      'RevocationNonNegative',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'grant' },
      { _tag: 'revoke' },
      { _tag: 'record', at: 0n },
      { _tag: 'record', at: 1n },
      { _tag: 'record', at: 2n },
      { _tag: 'record', at: 3n },
    ]);
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 5000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['status'] === 'revoked')).toBe(
      true,
    );
    expect(
      report.reachable((state) => state['revokedUpTo'] === state['epoch']),
    ).toBe(true);
  });

  it('a stale revocation record never rolls the pointer back', () => {
    let state = model.initial;
    state = model.transition(state, { _tag: 'grant' });
    expect(state).toMatchObject({ epoch: 1n, status: 'active' });
    state = model.transition(state, { _tag: 'revoke' });
    expect(state).toMatchObject({
      epoch: 1n,
      revokedUpTo: 1n,
      status: 'revoked',
    });

    // re-grant opens a new epoch; the old revocation stands
    state = model.transition(state, { _tag: 'grant' });
    expect(state).toMatchObject({
      epoch: 2n,
      revokedUpTo: 1n,
      status: 'active',
    });

    // a stale record for the old epoch is appended but ignored (forward-only)
    const stale = model.transition(state, { _tag: 'record', at: 1n });
    expect(stale).toMatchObject({
      epoch: 2n,
      revokedUpTo: 1n,
      status: 'active',
    });
    expect(violatedInvariants(model, stale)).toEqual([]);

    // a record at the current epoch revokes it
    const current = model.transition(state, { _tag: 'record', at: 2n });
    expect(current).toMatchObject({
      epoch: 2n,
      revokedUpTo: 2n,
      status: 'revoked',
    });
    expect(violatedInvariants(model, current)).toEqual([]);

    // a pointer ahead of its epoch is exactly what the invariant rejects
    expect(
      violatedInvariants(model, { ...current, revokedUpTo: 3n }),
    ).toContain('RevocationForwardOnly');
  });
});
