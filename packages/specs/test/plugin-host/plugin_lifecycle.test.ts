import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, stateKey } from '@quint-machine/core/testing';
import definitionJson from '../../src/plugin-host/plugin_lifecycle.model.generated.json';

// Spec-only verification: the generated model document is the substrate.
// Every invariant is read from the spec (`val` defs) — never hand-listed.
const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

describe('plugin-host / plugin lifecycle + manifest gate', () => {
  it('declares its invariants and starts uninstalled', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NoEscalationWithoutGate',
      'IsolateBound',
      'StatusValid',
      'RequestedValid',
    ]);
    expect(model.initial).toMatchObject({
      status: 'uninstalled',
      manifest: 'none',
      gate: 'closed',
      isolate: 'none',
      requested: 'none',
    });
    expect(violatedInvariants(model, model.initial)).toEqual([]);
  });

  it('no reachable state violates an invariant', () => {
    const exploration = explore(model, { maxDepth: 12, maxStates: 10_000 });
    expect(exploration.violations).toEqual([]);
    expect(exploration.states.length).toBeGreaterThan(1);
  });

  it('install allocates an isolate; activate needs the declared manifest', () => {
    const installed = model.transition(model.initial, { _tag: 'install' });
    // an uninstalled plugin cannot activate first
    const premature = model.transition(model.initial, { _tag: 'activate' });
    expect(premature).toMatchObject({ status: 'uninstalled' });

    expect(installed).toMatchObject({
      status: 'installed',
      manifest: 'declared',
      isolate: 'allocated',
      gate: 'closed',
    });
    const active = model.transition(installed, { _tag: 'activate' });
    expect(active).toMatchObject({ status: 'active' });
    expect(violatedInvariants(model, active)).toEqual([]);
  });

  it('widening the manifest is blocked until the gate approves', () => {
    const installed = model.transition(model.initial, { _tag: 'install' });
    // approve outside a pending gate does nothing: no escalation slips through
    const earlyApproval = model.transition(installed, { _tag: 'approve' });
    expect(earlyApproval).toMatchObject({
      manifest: 'declared',
      gate: 'closed',
    });

    const active = model.transition(installed, { _tag: 'activate' });
    const pending = model.transition(active, {
      _tag: 'escalate',
      scope: 'write',
    });
    // requesting the escalation still leaves the manifest declared
    expect(pending).toMatchObject({
      manifest: 'declared',
      gate: 'pending',
      requested: 'write',
    });
    expect(violatedInvariants(model, pending)).toEqual([]);

    const approved = model.transition(pending, { _tag: 'approve' });
    expect(approved).toMatchObject({ manifest: 'widened', gate: 'approved' });
    expect(violatedInvariants(model, approved)).toEqual([]);
  });

  it('rejection leaves the declared manifest and the isolate intact', () => {
    const active = model.transition(
      model.transition(model.initial, { _tag: 'install' }),
      { _tag: 'activate' },
    );
    const pending = model.transition(active, {
      _tag: 'escalate',
      scope: 'read',
    });
    const rejected = model.transition(pending, { _tag: 'reject' });
    expect(rejected).toMatchObject({
      status: 'active',
      manifest: 'declared',
      isolate: 'allocated',
      gate: 'rejected',
    });
    expect(violatedInvariants(model, rejected)).toEqual([]);
    // after rejection a fresh escalation can go pending again
    const retried = model.transition(rejected, {
      _tag: 'escalate',
      scope: 'read',
    });
    expect(retried).toMatchObject({ gate: 'pending' });
  });

  it('uninstall tears the isolate down and drops the manifest', () => {
    const approved = [
      { _tag: 'install' },
      { _tag: 'activate' },
      { _tag: 'escalate', scope: 'write' },
      { _tag: 'approve' },
    ].reduce<Record<string, string | boolean | bigint>>(
      (state, event) => model.transition(state, event),
      model.initial,
    );
    expect(approved).toMatchObject({ manifest: 'widened' });
    const gone = model.transition(approved, { _tag: 'uninstall' });
    expect(gone).toMatchObject({
      status: 'uninstalled',
      manifest: 'none',
      isolate: 'none',
      gate: 'closed',
      requested: 'none',
    });
    expect(violatedInvariants(model, gone)).toEqual([]);
  });

  it('escalation is reachable; a widened manifest without the gate is not', () => {
    const exploration = explore(model, { maxDepth: 12, maxStates: 10_000 });
    const canReach = (
      state: Record<string, string | boolean | bigint>,
    ): boolean =>
      exploration.reachable(
        (candidate) => stateKey(model, candidate) === stateKey(model, state),
      );
    const approved = [
      { _tag: 'install' },
      { _tag: 'activate' },
      { _tag: 'escalate', scope: 'write' },
      { _tag: 'approve' },
    ].reduce<Record<string, string | boolean | bigint>>(
      (state, event) => model.transition(state, event),
      model.initial,
    );
    expect(canReach(approved)).toBe(true);
    // widened manifest with the gate still closed/pending is never reached
    expect(
      canReach({
        status: 'active',
        manifest: 'widened',
        gate: 'pending',
        isolate: 'allocated',
        requested: 'write',
      }),
    ).toBe(false);
  });

  it('invariants have teeth on synthetic bad states', () => {
    expect(
      violatedInvariants(model, {
        status: 'active',
        manifest: 'widened',
        gate: 'pending',
        isolate: 'allocated',
        requested: 'write',
      }),
    ).toEqual(['NoEscalationWithoutGate']);

    expect(
      violatedInvariants(model, {
        status: 'uninstalled',
        manifest: 'none',
        gate: 'closed',
        isolate: 'allocated',
        requested: 'none',
      }),
    ).toEqual(['IsolateBound']);

    expect(
      violatedInvariants(model, {
        status: 'zombie',
        manifest: 'widened',
        gate: 'closed',
        isolate: 'allocated',
        requested: 'root',
      }),
    ).toEqual(['NoEscalationWithoutGate', 'StatusValid', 'RequestedValid']);
  });
});
