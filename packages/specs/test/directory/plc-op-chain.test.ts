import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import definitionJson from '../../src/directory/plc-op-chain.model.generated.json';
import { explore } from '@quint-machine/core/testing';

// Spec-only verification of the did:plc op-chain machine: events come from the
// spec's own pools, `transition` is stepped, and every spec invariant is checked
// after every step. No Effect runtime is involved.
const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('directory: did:plc op-chain', () => {
  it('exposes the spec-declared invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'DidStableAcrossRotation',
      'ForkNullified',
      'LifecycleValid',
      'HeadKindValid',
    ]);
  });

  it('holds every invariant across the explored state space', () => {
    const report = explore(model, { maxDepth: 5, maxStates: 20_000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.transitions.length).toBeGreaterThan(0);
  });

  it('invariants have teeth', () => {
    expect(
      violatedInvariants(model, { ...model.initial, lifecycle: 'zombie' }),
    ).toContain('LifecycleValid');
    expect(
      violatedInvariants(model, {
        ...model.initial,
        lifecycle: 'active',
        did: 'did:plc:evil',
      }),
    ).toContain('DidStableAcrossRotation');
    expect(
      violatedInvariants(model, {
        ...model.initial,
        canonicalLen: 4n,
        nullified: 1n,
        logLen: 4n,
        forkCount: 1n,
      }),
    ).toContain('ForkNullified');
    expect(
      violatedInvariants(model, { ...model.initial, headKind: 'plc_evil' }),
    ).toContain('HeadKindValid');
  });

  it('rotation keeps the DID stable', () => {
    const created = model.transition(model.initial, { _tag: 'create' });
    const rotated = model.transition(
      model.transition(created, { _tag: 'rotate', newKey: 'keyB' }),
      { _tag: 'rotate', newKey: 'keyA' },
    );
    expect(rotated.lifecycle).toBe('active');
    expect(rotated.did).toBe('did:plc:genesis');
    expect(rotated.rotationKey).toBe('keyA');
    expect(violatedInvariants(model, rotated)).toEqual([]);
  });

  it('a conflicting operation is nullified, not merged', () => {
    let state = model.transition(model.initial, { _tag: 'create' });
    state = model.transition(state, { _tag: 'rotate', newKey: 'keyB' });
    state = model.transition(state, {
      _tag: 'rebind',
      target: 'bob.example.com',
    });
    expect(state.logLen).toBe(3n);
    expect(state.canonicalLen).toBe(3n);
    expect(state.nullified).toBe(0n);

    const forked = model.transition(state, {
      _tag: 'nullify',
      scope: 'ancestor',
    });
    expect(forked.forkCount).toBe(1n);
    expect(forked.logLen).toBe(4n);
    expect(forked.canonicalLen).toBe(2n);
    expect(forked.nullified).toBe(2n);
    expect(violatedInvariants(model, forked)).toEqual([]);

    // the nullified tail stays nullified: a later append extends the new head
    const appended = model.transition(forked, {
      _tag: 'rotate',
      newKey: 'keyB',
    });
    expect(appended.nullified).toBe(2n);
    expect(appended.canonicalLen).toBe(3n);
    expect(appended.logLen).toBe(5n);
    expect(violatedInvariants(model, appended)).toEqual([]);
  });

  it('a fork from a bare genesis is impossible', () => {
    const created = model.transition(model.initial, { _tag: 'create' });
    const attempted = model.transition(created, {
      _tag: 'nullify',
      scope: 'ancestor',
    });
    expect(attempted.forkCount).toBe(0n);
    expect(attempted.nullified).toBe(0n);
    expect(attempted.canonicalLen).toBe(1n);
  });

  it('a tombstone is terminal', () => {
    let state = model.transition(model.initial, { _tag: 'create' });
    state = model.transition(state, { _tag: 'tombstone' });
    expect(state.lifecycle).toBe('tombstoned');
    expect(state.headKind).toBe('plc_tombstone');
    expect(model.transition(state, { _tag: 'rotate', newKey: 'keyB' })).toEqual(
      state,
    );
    expect(
      model.transition(state, { _tag: 'rebind', target: 'bob.example.com' }),
    ).toEqual(state);
    expect(model.transition(state, { _tag: 'create' })).toEqual(state);
  });
});
