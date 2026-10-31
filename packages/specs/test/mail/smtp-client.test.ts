import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/mail/smtp-client.model.generated.json';

// Spec-only verification of the SMTP submission *client*: the same dialogue as
// `smtp-security.qnt` from the other end, where the invariants are the client's.
//
// The two that matter most are the ones a server cannot enforce for us — never
// sending credentials on an unencrypted session, and never sending them on
// capabilities learned before the upgrade — because by the time a server refuses
// them, the password is already on the wire.

const model = makeReferenceModel(decodeDefinition(definitionJson));

const step = (state: typeof model.initial, event: Record<string, unknown>) => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

/** 220 then EHLO — how every conversation starts, and where a downgrade lands. */
const greeting = (advertises: boolean) =>
  step(step(model.initial, { _tag: 'greeting' }), {
    _tag: 'ehlo',
    advertises,
  });

/** Greeting, upgrade, and the EHLO that must follow it. */
const secured = (advertises = true) =>
  step(step(greeting(advertises), { _tag: 'starttls', ok: true }), {
    _tag: 'ehlo',
    advertises: false,
  });

describe('mail: SMTP submission client (spec-only)', () => {
  it('declares the client invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StageValid',
      'NoCredentialsInTheClear',
      'AuthOnlyAfterReGreeting',
      'TlsImpliesAdvertised',
      'UpgradeAtMostOnce',
      'SentImpliesAccepted',
      'EnvelopeImpliesAuthed',
      'NoSecondEnvelope',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'greeting' },
      { _tag: 'ehlo', advertises: true },
      { _tag: 'ehlo', advertises: false },
      { _tag: 'starttls', ok: true },
      { _tag: 'starttls', ok: false },
      { _tag: 'auth', ok: true },
      { _tag: 'auth', ok: false },
      { _tag: 'abandon' },
      { _tag: 'mailFrom', ok: true },
      { _tag: 'mailFrom', ok: false },
      { _tag: 'rcpt', ok: true },
      { _tag: 'rcpt', ok: false },
      { _tag: 'data', ok: true },
      { _tag: 'data', ok: false },
      { _tag: 'quit' },
    ]);
  });

  it('sends credentials only after the upgrade *and* the EHLO that follows it', () => {
    const upgraded = step(greeting(true), { _tag: 'starttls', ok: true });
    expect(upgraded).toMatchObject({
      tls: true,
      tries: 1n,
      regreeted: false,
      stage: 'greeted',
    });

    // Encrypted, and still refused: the capabilities in hand are the ones from
    // before the upgrade, which are exactly the ones a man in the middle could
    // have written.
    const tooEarly = step(upgraded, { _tag: 'auth', ok: true });
    expect(tooEarly).toMatchObject({
      authed: false,
      tls: true,
      regreeted: false,
      lastCode: 530n,
    });

    // The invariant is real: authenticating on pre-upgrade capabilities is
    // caught by name.
    expect(violatedInvariants(model, { ...tooEarly, authed: true })).toContain(
      'AuthOnlyAfterReGreeting',
    );

    const ready = step(upgraded, { _tag: 'ehlo', advertises: false });
    expect(ready).toMatchObject({ regreeted: true });
    const authenticated = step(ready, { _tag: 'auth', ok: true });
    expect(authenticated).toMatchObject({ authed: true, lastCode: 235n });
  });

  it('gives up rather than authenticate in the clear when STARTTLS is stripped', () => {
    // The man in the middle's move: the EHLO reply simply does not offer it.
    const stripped = greeting(false);
    expect(stripped).toMatchObject({ advertised: false, tls: false });

    const attempted = step(stripped, { _tag: 'starttls', ok: true });
    expect(attempted).toMatchObject({ tls: false, tries: 0n, lastCode: 503n });

    const refused = step(stripped, { _tag: 'auth', ok: true });
    expect(refused).toMatchObject({ authed: false, lastCode: 530n });

    // And the client abandons: not a failure, the alternative was the password.
    const gone = step(refused, { _tag: 'abandon' });
    expect(gone).toMatchObject({ stage: 'closed' });

    // The headline invariant is real, and it is the client's own rule: a state
    // that authenticated without encryption is caught by name.
    expect(violatedInvariants(model, { ...refused, authed: true })).toContain(
      'NoCredentialsInTheClear',
    );
  });

  it('only hands a message over once somebody agreed to take it', () => {
    const ready = step(secured(), { _tag: 'auth', ok: true });
    const opened = step(ready, { _tag: 'mailFrom', ok: true });
    expect(opened).toMatchObject({ stage: 'envelope' });

    // No RCPT yet, so DATA is refused and nothing is sent.
    const early = step(opened, { _tag: 'data', ok: true });
    expect(early).toMatchObject({ sent: false, accepted: 0n, lastCode: 503n });

    // One accepted and one refused: the message goes, and the counts stay apart.
    const took = step(opened, { _tag: 'rcpt', ok: true });
    const rejected = step(took, { _tag: 'rcpt', ok: false });
    expect(rejected).toMatchObject({ accepted: 1n, refused: 1n });

    const sent = step(rejected, { _tag: 'data', ok: true });
    expect(sent).toMatchObject({ sent: true, stage: 'sent', lastCode: 250n });

    // The invariant is real: a message handed over with nobody accepting it is
    // caught by name.
    expect(violatedInvariants(model, { ...early, sent: true })).toContain(
      'SentImpliesAccepted',
    );
  });

  it('makes the upgrade unreachable once an envelope is open, so state is enough', () => {
    const ready = step(secured(), { _tag: 'auth', ok: true });
    const opened = step(ready, { _tag: 'mailFrom', ok: true });
    const took = step(opened, { _tag: 'rcpt', ok: true });
    expect(took).toMatchObject({ accepted: 1n, tries: 1n });

    // The upgrade already happened and `tries` is spent, so nothing can reset the
    // count after a send. That is why `sent -> accepted > 0` is a true state
    // predicate here, and why this machine needs no monotone witness of the kind
    // the IMAP machine did — the analogy did not hold, and the exploration says
    // so rather than the comment.
    const again = step(took, { _tag: 'starttls', ok: true });
    expect(again).toMatchObject({ accepted: 1n, tries: 1n, lastCode: 503n });

    const sent = step(took, { _tag: 'data', ok: true });
    expect(sent).toMatchObject({ sent: true, accepted: 1n });
    expect(violatedInvariants(model, sent)).toEqual([]);
  });

  it('advertised only ever moves to true, and the upgrade happens at most once', () => {
    const offered = greeting(true);
    const silent = step(offered, { _tag: 'ehlo', advertises: false });
    expect(silent).toMatchObject({ advertised: true });

    const upgraded = step(offered, { _tag: 'starttls', ok: true });
    const again = step(upgraded, { _tag: 'starttls', ok: true });
    expect(again).toMatchObject({ tries: 1n, tls: true, lastCode: 503n });
    expect(violatedInvariants(model, { ...again, tries: 2n })).toContain(
      'UpgradeAtMostOnce',
    );
  });

  it('does nothing at all once the session is closed', () => {
    const closed = step(greeting(true), { _tag: 'quit' });
    expect(closed).toMatchObject({ stage: 'closed' });

    for (const event of eventsOf(model)) {
      const after = model.transition(closed, event);
      expect(after).toEqual(closed);
    }
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 10, maxStates: 80_000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['tls'] === true)).toBe(true);
    expect(report.reachable((state) => state['authed'] === true)).toBe(true);
    expect(report.reachable((state) => state['sent'] === true)).toBe(true);
    expect(report.reachable((state) => state['lastCode'] === 454n)).toBe(true);
    expect(report.reachable((state) => state['lastCode'] === 530n)).toBe(true);
    expect(report.reachable((state) => state['stage'] === 'closed')).toBe(true);
  });
});
