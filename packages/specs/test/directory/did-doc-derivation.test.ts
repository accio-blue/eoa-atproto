import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import definitionJson from '../../src/directory/did-doc-derivation.model.generated.json';
import { explore } from '@quint-machine/core/testing';

// Spec-only verification of DID-document derivation: the document is rendered
// from the head operation, rotation keys never leak into it, and a tombstone
// withholds it.
const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('directory: DID document derivation', () => {
  it('exposes the spec-declared invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'DocumentEpochNotAhead',
      'DocMatchesHeadWhenRendered',
      'RotationKeysNeverExposed',
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
      violatedInvariants(model, {
        ...model.initial,
        headEpoch: 0n,
        docEpoch: 1n,
      }),
    ).toContain('DocumentEpochNotAhead');
    const consistent = {
      ...model.initial,
      headKind: 'plc_operation',
      headSigningKey: 'sigA',
      headHandle: 'alice.example.com',
      headPds: 'pds.one',
      headEpoch: 1n,
      docEpoch: 1n,
      docRendered: true,
      docId: 'did:plc:genesis',
      docAlias: 'alice.example.com',
      docKey: 'sigA',
      docService: 'pds.one',
    };
    expect(violatedInvariants(model, consistent)).toEqual([]);
    expect(
      violatedInvariants(model, { ...consistent, docAlias: 'bob.example.com' }),
    ).toContain('DocMatchesHeadWhenRendered');
    expect(
      violatedInvariants(model, { ...model.initial, docRotationExposed: true }),
    ).toContain('RotationKeysNeverExposed');
  });

  it('renders the document from the head operation', () => {
    let state = model.transition(model.initial, {
      _tag: 'install',
      bundle: 'genesis-A',
    });
    expect(state.headEpoch).toBe(1n);
    expect(state.docEpoch).toBe(0n);

    state = model.transition(state, { _tag: 'render' });
    expect(state.docEpoch).toBe(1n);
    expect(state.docRendered).toBe(true);
    expect(state.docId).toBe('did:plc:genesis');
    expect(state.docAlias).toBe('alice.example.com');
    expect(state.docKey).toBe('sigA');
    expect(state.docService).toBe('pds.one');
    expect(state.docRotationExposed).toBe(false);
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a tombstoned account has no document', () => {
    let state = model.transition(model.initial, {
      _tag: 'install',
      bundle: 'tombstone',
    });
    state = model.transition(state, { _tag: 'render' });
    expect(state.headKind).toBe('plc_tombstone');
    expect(state.docRendered).toBe(false);
    expect(state.docAlias).toBe('none');
    expect(state.docKey).toBe('none');
    expect(state.docService).toBe('none');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a stale document is replaced on the next render', () => {
    let state = model.transition(model.initial, {
      _tag: 'install',
      bundle: 'genesis-A',
    });
    state = model.transition(state, { _tag: 'render' });
    state = model.transition(state, {
      _tag: 'install',
      bundle: 'genesis-B',
    });
    // head moved on; the old document is stale but the invariants still hold
    expect(state.headEpoch).toBe(2n);
    expect(state.docEpoch).toBe(1n);
    expect(state.docAlias).toBe('alice.example.com');

    state = model.transition(state, { _tag: 'render' });
    expect(state.docEpoch).toBe(2n);
    expect(state.docAlias).toBe('bob.example.com');
    expect(state.docKey).toBe('sigB');
    expect(state.docService).toBe('pds.two');
    expect(violatedInvariants(model, state)).toEqual([]);
  });
});
