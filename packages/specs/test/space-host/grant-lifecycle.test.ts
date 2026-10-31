import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/space-host/grant-lifecycle.model.generated.json';

// Spec-only verification of the Space host grant lifecycle: the generated model
// is the substrate, the events come from the spec's own pools, and every
// declared invariant is checked after every reachable step.

const model = makeReferenceModel(decodeDefinition(definitionJson));

describe('space-host: grant lifecycle (spec-only)', () => {
  it('declares the fail-closed invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'GrantFailClosed',
      'NoMergeOnConflict',
      'HeadNonNegative',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'issue' },
      { _tag: 'use', fresh: true },
      { _tag: 'use', fresh: false },
      { _tag: 'revoke' },
    ]);
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 5000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    // reachability: revocation, commit and conflict states are all explored
    expect(report.reachable((state) => state['grant'] === 'revoked')).toBe(
      true,
    );
    expect(report.reachable((state) => state['outcome'] === 'committed')).toBe(
      true,
    );
    expect(report.reachable((state) => state['outcome'] === 'conflict')).toBe(
      true,
    );
    expect(report.reachable((state) => state['outcome'] === 'denied')).toBe(
      true,
    );
  });

  it('a revoked grant denies every later use (fail-closed)', () => {
    let state = model.initial;
    state = model.transition(state, { _tag: 'issue' });
    state = model.transition(state, { _tag: 'use', fresh: true });
    expect(state).toMatchObject({
      grant: 'active',
      logHead: 1n,
      outcome: 'committed',
    });

    state = model.transition(state, { _tag: 'revoke' });
    expect(state).toMatchObject({ grant: 'revoked' });

    const deniedFresh = model.transition(state, { _tag: 'use', fresh: true });
    expect(deniedFresh).toMatchObject({
      grant: 'revoked',
      logHead: 1n,
      outcome: 'denied',
    });
    expect(violatedInvariants(model, deniedFresh)).toEqual([]);

    const deniedStale = model.transition(state, { _tag: 'use', fresh: false });
    expect(deniedStale).toMatchObject({
      grant: 'revoked',
      logHead: 1n,
      outcome: 'denied',
    });
  });

  it('a stale CAS base conflicts and never merges', () => {
    let state = model.initial;
    state = model.transition(state, { _tag: 'issue' });
    const conflicted = model.transition(state, { _tag: 'use', fresh: false });
    expect(conflicted).toMatchObject({
      logHead: 0n,
      expected: 1n,
      outcome: 'conflict',
    });
    expect(violatedInvariants(model, conflicted)).toEqual([]);

    // a merge would have advanced the head on the stale base — the invariant
    // has teeth: this planted state is rejected by name
    expect(violatedInvariants(model, { ...conflicted, logHead: 1n })).toContain(
      'NoMergeOnConflict',
    );
  });
});
