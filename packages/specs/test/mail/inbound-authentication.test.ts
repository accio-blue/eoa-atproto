import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/mail/inbound-authentication.model.generated.json';

// Spec-only verification of the inbound authentication decision: SPF, DKIM and
// DMARC, and the rule that a pass without alignment is not authentication.
//
// The `check` selector encodes a whole result set — 1 is an aligned SPF pass, 2
// is the same pass *unaligned* (the spoof), 3 and 4 are the DKIM pair.

const model = makeReferenceModel(decodeDefinition(definitionJson));

const step = (state: typeof model.initial, event: Record<string, unknown>) => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

/** The domain's policy, then a result set. */
const checked = (policy: string, scenario: bigint) =>
  step(step(model.initial, { _tag: 'setPolicy', chosen: policy }), {
    _tag: 'check',
    scenario,
  });

describe('mail: inbound authentication (spec-only)', () => {
  it('declares the decision invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'DispositionValid',
      'DmarcPassImpliesAlignedPass',
      'RejectOnlyUnderRejectPolicy',
      'QuarantineOnlyUnderQuarantinePolicy',
      'DeliveredUnderPolicyImpliesPass',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'setPolicy', chosen: 'none' },
      { _tag: 'setPolicy', chosen: 'quarantine' },
      { _tag: 'setPolicy', chosen: 'reject' },
      { _tag: 'check', scenario: 0n },
      { _tag: 'check', scenario: 1n },
      { _tag: 'check', scenario: 2n },
      { _tag: 'check', scenario: 3n },
      { _tag: 'check', scenario: 4n },
      { _tag: 'check', scenario: 5n },
    ]);
  });

  it('does not call an unaligned pass authentication', () => {
    // Scenario 1: SPF passed and aligned — that is authentication.
    const aligned = checked('reject', 1n);
    expect(aligned).toMatchObject({
      spf: 'pass',
      spfAligned: true,
      dmarc: 'pass',
      disposition: 'deliver',
    });

    // Scenario 2: the same SPF pass, on a domain that does not align with the
    // From header. This is the spoof, and it is not a pass.
    const spoof = checked('reject', 2n);
    expect(spoof).toMatchObject({
      spf: 'pass',
      spfAligned: false,
      dmarc: 'fail',
      disposition: 'reject',
    });

    // And the invariant is real: a DMARC pass with nothing aligned behind it is
    // caught by name.
    expect(violatedInvariants(model, { ...spoof, dmarc: 'pass' })).toContain(
      'DmarcPassImpliesAlignedPass',
    );
  });

  it('takes the disposition from the policy, and only from the policy', () => {
    // DKIM passed and aligned (scenario 3): authentication under any policy.
    expect(checked('reject', 3n)).toMatchObject({
      dmarc: 'pass',
      disposition: 'deliver',
    });
    // DKIM passed but unaligned (scenario 4): not authentication.
    expect(checked('reject', 4n)).toMatchObject({
      dmarc: 'fail',
      disposition: 'reject',
    });

    // And the same failure under each policy:
    expect(checked('none', 5n)).toMatchObject({ disposition: 'deliver' });
    expect(checked('quarantine', 5n)).toMatchObject({
      disposition: 'quarantine',
    });
    expect(checked('reject', 5n)).toMatchObject({ disposition: 'reject' });

    // A rejection nobody asked for is caught by name.
    expect(
      violatedInvariants(model, {
        ...checked('none', 5n),
        disposition: 'reject',
      }),
    ).toContain('RejectOnlyUnderRejectPolicy');
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 5, maxStates: 20_000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['dmarc'] === 'pass')).toBe(true);
    expect(report.reachable((state) => state['dmarc'] === 'fail')).toBe(true);
    expect(
      report.reachable((state) => state['disposition'] === 'quarantine'),
    ).toBe(true);
    expect(report.reachable((state) => state['disposition'] === 'reject')).toBe(
      true,
    );
  });
});
