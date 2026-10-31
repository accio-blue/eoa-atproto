import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/_shared-proof/auth-decision.model.generated.json';

// Proof that shared/auth.qnt (the grant decision oracle) is importable and that
// its decision is fail-closed: the generated model is the substrate, events
// come from the spec's own pools, and every declared invariant is checked.

const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('shared/auth: grant decision oracle (proof)', () => {
  it('declares the fail-closed invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'FailClosed',
      'NoGrantNoAccess',
    ]);
  });

  it('derives its event alphabet from the spec pools', () => {
    expect(eventsOf(model).length).toBeGreaterThan(5);
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 5000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    // reachability: a permitted decision and a revoked grant are both explored
    expect(report.reachable((state) => state['allowed'] === true)).toBe(true);
    expect(report.reachable((state) => state['grant'] === 'revoked')).toBe(
      true,
    );
  });

  it('invariants have teeth against a fabricated bad state', () => {
    // permission granted with no active grant must violate fail-closed
    expect(
      violatedInvariants(model, {
        grant: 'none',
        subjectOk: true,
        verb: 'view',
        selectorOk: true,
        expired: false,
        allowed: true,
      }),
    ).toContain('FailClosed');
  });
});
