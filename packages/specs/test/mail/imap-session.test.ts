import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/mail/imap-session.model.generated.json';

// Spec-only verification of the IMAP session: the state machine every command is
// legal in exactly one of, and the UID promise a client's cache is built on.

const model = makeReferenceModel(decodeDefinition(definitionJson));

const step = (state: typeof model.initial, event: Record<string, unknown>) => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

describe('mail: IMAP session (spec-only)', () => {
  it('declares the state-machine and UID invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StateValid',
      'NoFetchBeforeSelect',
      'UidNextAboveAssigned',
      'ServedWasAssigned',
      'SelectedHasMailbox',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'login', ok: true },
      { _tag: 'login', ok: false },
      { _tag: 'openMailbox', ok: true },
      { _tag: 'openMailbox', ok: false },
      { _tag: 'examine', ok: true },
      { _tag: 'examine', ok: false },
      { _tag: 'fetch', ok: true },
      { _tag: 'fetch', ok: false },
      { _tag: 'deliver' },
      { _tag: 'noop' },
      { _tag: 'logout' },
    ]);
  });

  it('walks the states, and serves only inside a selected session', () => {
    const authed = step(model.initial, { _tag: 'login', ok: true });
    expect(authed).toMatchObject({ state: 'authenticated', lastOutcome: 'ok' });

    const opened = step(authed, { _tag: 'openMailbox', ok: true });
    expect(opened).toMatchObject({
      state: 'selected',
      selected: 'INBOX',
      lastOutcome: 'ok',
    });

    // A message arrives: it takes the next UID, and the counter moves past it.
    const arrived = step(opened, { _tag: 'deliver' });
    expect(arrived).toMatchObject({ uidNext: 2n, assignedMax: 1n });

    const served = step(arrived, { _tag: 'fetch', ok: true });
    expect(served).toMatchObject({ lastUid: 1n, lastOutcome: 'ok' });

    const bye = step(served, { _tag: 'logout' });
    expect(bye).toMatchObject({ state: 'logout', lastOutcome: 'ok' });
  });

  it('opens the mailbox for a client that asks for it read-only', () => {
    const authed = step(model.initial, { _tag: 'login', ok: true });
    const examined = step(authed, { _tag: 'examine', ok: true });
    expect(examined).toMatchObject({
      state: 'selected',
      selected: 'INBOX',
      everSelected: true,
      lastOutcome: 'ok',
    });
    // And it opens nothing before authentication: EXAMINE is not a way round
    // LOGIN.
    const early = step(model.initial, { _tag: 'examine', ok: true });
    expect(early).toMatchObject({
      state: 'not-authenticated',
      lastOutcome: 'no',
    });
  });

  it('lets a client open a mailbox while one is already open', () => {
    const opened = step(step(model.initial, { _tag: 'login', ok: true }), {
      _tag: 'openMailbox',
      ok: true,
    });
    // RFC 3501 6.3.1: SELECT is valid in the selected state too. A client
    // re-opens a mailbox to refresh it, and refusing that is a client that
    // cannot see new mail.
    const again = step(opened, { _tag: 'examine', ok: true });
    expect(again).toMatchObject({
      state: 'selected',
      selected: 'INBOX',
      lastOutcome: 'ok',
    });
  });

  it('refuses to serve anything before the mailbox is opened', () => {
    const authed = step(model.initial, { _tag: 'login', ok: true });
    const early = step(authed, { _tag: 'fetch', ok: true });
    expect(early).toMatchObject({
      state: 'authenticated',
      lastUid: 0n,
      lastOutcome: 'no',
    });

    // The invariant is real: a message served outside a selected session is
    // caught by name.
    expect(violatedInvariants(model, { ...early, lastUid: 1n })).toContain(
      'NoFetchBeforeSelect',
    );
  });

  it('never reuses a UID', () => {
    const opened = step(step(model.initial, { _tag: 'login', ok: true }), {
      _tag: 'openMailbox',
      ok: true,
    });
    const arrived = step(opened, { _tag: 'deliver' });
    expect(arrived).toMatchObject({ uidNext: 2n, assignedMax: 1n });

    // The invariant is real: winding the counter back — handing out a UID that
    // already means something — is caught by name.
    expect(violatedInvariants(model, { ...arrived, uidNext: 1n })).toContain(
      'UidNextAboveAssigned',
    );
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 50_000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['state'] === 'selected')).toBe(
      true,
    );
    expect(report.reachable((state) => state['state'] === 'logout')).toBe(true);
    expect(report.reachable((state) => state['lastUid'] !== 0n)).toBe(true);
    expect(
      report.reachable((state) => (state['assignedMax'] ?? 0n) === 2n),
    ).toBe(true);
  });
});
