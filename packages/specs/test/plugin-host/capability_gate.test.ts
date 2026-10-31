import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, stateKey } from '@quint-machine/core/testing';
import definitionJson from '../../src/plugin-host/capability_gate.model.generated.json';

// Spec-only verification: the generated model document is the substrate.
// Every invariant is read from the spec (`val` defs) — never hand-listed.
const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (
  state: Record<string, string | boolean | bigint>,
  event: { readonly _tag: string; readonly [field: string]: string | boolean },
) => model.transition(state, event);

describe('plugin-host / capability bridge (deny-by-default)', () => {
  it('declares DenyByDefault and starts with nothing declared', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'DenyByDefault',
      'DecisionValid',
      'RequestedValid',
    ]);
    expect(model.initial).toMatchObject({
      declaredRead: false,
      declaredWrite: false,
      requested: 'none',
      decision: 'none',
    });
    expect(violatedInvariants(model, model.initial)).toEqual([]);
  });

  it('no reachable state violates an invariant', () => {
    const exploration = explore(model, { maxDepth: 12, maxStates: 10_000 });
    expect(exploration.violations).toEqual([]);
    expect(exploration.states.length).toBeGreaterThan(1);
  });

  it('an undeclared capability is denied by default', () => {
    const read = step(model.initial, { _tag: 'request', cap: 'read' });
    expect(read).toMatchObject({ requested: 'read', decision: 'denied' });

    // admin is never declarable: denied whatever else is declared
    const declaredBoth = step(
      step(model.initial, { _tag: 'declare', cap: 'read' }),
      { _tag: 'declare', cap: 'write' },
    );
    const admin = step(declaredBoth, { _tag: 'request', cap: 'admin' });
    expect(admin).toMatchObject({ requested: 'admin', decision: 'denied' });
  });

  it('a declared capability is granted, and revoking withdraws it', () => {
    const declared = step(model.initial, { _tag: 'declare', cap: 'read' });
    // declaring invalidates the previous decision
    expect(declared.decision).toBe('none');
    const granted = step(declared, { _tag: 'request', cap: 'read' });
    expect(granted).toMatchObject({ requested: 'read', decision: 'granted' });
    expect(violatedInvariants(model, granted)).toEqual([]);

    const revoked = step(granted, { _tag: 'revoke', cap: 'read' });
    expect(revoked.decision).toBe('none');
    const deniedAgain = step(revoked, { _tag: 'request', cap: 'read' });
    expect(deniedAgain.decision).toBe('denied');
  });

  it('write stays denied while only read is declared', () => {
    const declaredRead = step(model.initial, {
      _tag: 'declare',
      cap: 'read',
    });
    const writeRead = step(declaredRead, { _tag: 'request', cap: 'write' });
    expect(writeRead).toMatchObject({ decision: 'denied' });
    const readRead = step(declaredRead, { _tag: 'request', cap: 'read' });
    expect(readRead).toMatchObject({ decision: 'granted' });
  });

  it('a grant is reachable; a grant for an undeclared capability is not', () => {
    const exploration = explore(model, { maxDepth: 12, maxStates: 10_000 });
    const canReach = (
      state: Record<string, string | boolean | bigint>,
    ): boolean =>
      exploration.reachable(
        (candidate) => stateKey(model, candidate) === stateKey(model, state),
      );
    expect(
      canReach({
        declaredRead: true,
        declaredWrite: false,
        requested: 'read',
        decision: 'granted',
      }),
    ).toBe(true);
    expect(
      canReach({
        declaredRead: false,
        declaredWrite: false,
        requested: 'read',
        decision: 'granted',
      }),
    ).toBe(false);
    expect(
      canReach({
        declaredRead: true,
        declaredWrite: true,
        requested: 'admin',
        decision: 'granted',
      }),
    ).toBe(false);
  });

  it('DenyByDefault has teeth on synthetic bad states', () => {
    expect(
      violatedInvariants(model, {
        declaredRead: false,
        declaredWrite: false,
        requested: 'read',
        decision: 'granted',
      }),
    ).toEqual(['DenyByDefault']);

    expect(
      violatedInvariants(model, {
        declaredRead: true,
        declaredWrite: false,
        requested: 'write',
        decision: 'granted',
      }),
    ).toEqual(['DenyByDefault']);

    expect(
      violatedInvariants(model, {
        declaredRead: true,
        declaredWrite: true,
        requested: 'read',
        decision: 'granted',
      }),
    ).toEqual([]);
  });
});
