import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import definitionJson from '../../src/directory/handle-resolution.model.generated.json';
import { explore } from '@quint-machine/core/testing';

// Spec-only verification of the handle-resolution machine: DNS TXT first, the
// `.well-known` document as fallback, then the DID document's claim decides.
const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('directory: handle resolution', () => {
  it('exposes the spec-declared invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'HandleResolves',
      'SourceValid',
      'DnsBeforeWellKnown',
      'PhaseValid',
    ]);
  });

  it('holds every invariant across the explored state space', () => {
    const report = explore(model, { maxDepth: 16, maxStates: 20_000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.transitions.length).toBeGreaterThan(0);
  });

  it('invariants have teeth', () => {
    expect(
      violatedInvariants(model, {
        ...model.initial,
        phase: 'resolved',
        source: 'dns',
        resolvedDid: 'none',
      }),
    ).toContain('HandleResolves');
    expect(
      violatedInvariants(model, { ...model.initial, source: 'carrier-pigeon' }),
    ).toContain('SourceValid');
    expect(
      violatedInvariants(model, {
        ...model.initial,
        source: 'well-known',
        dns: 'did:plc:alice',
      }),
    ).toContain('DnsBeforeWellKnown');
    expect(
      violatedInvariants(model, { ...model.initial, phase: 'limbo' }),
    ).toContain('PhaseValid');
  });

  it('DNS TXT wins and the document claim resolves the handle', () => {
    let state = model.transition(model.initial, {
      _tag: 'dnsLookup',
      result: 'did:plc:alice',
    });
    expect(state.phase).toBe('verifying');
    expect(state.source).toBe('dns');
    expect(state.resolvedDid).toBe('did:plc:alice');

    state = model.transition(state, {
      _tag: 'verify',
      claim: 'alice.example.com',
    });
    expect(state.phase).toBe('resolved');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('falls back to well-known only when DNS is missing', () => {
    let state = model.transition(model.initial, {
      _tag: 'dnsLookup',
      result: 'missing',
    });
    expect(state.phase).toBe('well-known');
    expect(state.source).toBe('none');

    state = model.transition(state, {
      _tag: 'wellKnownLookup',
      result: 'did:plc:other',
    });
    expect(state.phase).toBe('verifying');
    expect(state.source).toBe('well-known');
    expect(state.resolvedDid).toBe('did:plc:other');

    state = model.transition(state, {
      _tag: 'verify',
      claim: 'alice.example.com',
    });
    expect(state.phase).toBe('resolved');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('both lookups missing leaves the handle unresolved', () => {
    let state = model.transition(model.initial, {
      _tag: 'dnsLookup',
      result: 'missing',
    });
    state = model.transition(state, {
      _tag: 'wellKnownLookup',
      result: 'missing',
    });
    expect(state.phase).toBe('unresolved');
    expect(state.source).toBe('none');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a document that does not claim the handle is a mismatch, not a resolution', () => {
    let state = model.transition(model.initial, {
      _tag: 'dnsLookup',
      result: 'did:plc:alice',
    });
    state = model.transition(state, {
      _tag: 'verify',
      claim: 'bob.example.com',
    });
    expect(state.phase).toBe('mismatch');
    expect(state.docHandle).toBe('bob.example.com');
    expect(violatedInvariants(model, state)).toEqual([]);
  });
});
