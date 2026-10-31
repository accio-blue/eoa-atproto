import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/mail/smtp-security.model.generated.json';

// Spec-only verification of the SMTP submission security machine: STARTTLS,
// AUTH, and the two rules that make offering AUTH defensible at all.
//
// The `configure` selector picks the deployment — 0 no certificate and
// opportunistic, 1 certificate and opportunistic (an MX), 2 no certificate and
// strict, 3 certificate and strict (submission).

const model = makeReferenceModel(decodeDefinition(definitionJson));

const step = (state: typeof model.initial, event: Record<string, unknown>) => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

/** init -> configure -> ehlo, which is how every conversation starts. */
const greeting = (setup: bigint) =>
  step(step(model.initial, { _tag: 'configure', setup }), { _tag: 'ehlo' });

describe('mail: SMTP submission security (spec-only)', () => {
  it('declares the security invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StageValid',
      'NoAuthBeforeTls',
      'AskingImpliesTls',
      'TlsImpliesOffered',
      'UpgradeAtMostOnce',
      'EnvelopeFromThisEpoch',
      'StrictImpliesTlsForEnvelope',
      'TlsImpliesGreeted',
      'RemoteImpliesAuthed',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'configure', setup: 0n },
      { _tag: 'configure', setup: 1n },
      { _tag: 'configure', setup: 2n },
      { _tag: 'configure', setup: 3n },
      { _tag: 'ehlo' },
      { _tag: 'starttls', ok: true },
      { _tag: 'starttls', ok: false },
      { _tag: 'auth', ok: true },
      { _tag: 'auth', ok: false },
      { _tag: 'authStart' },
      { _tag: 'authPayload', ok: true },
      { _tag: 'authPayload', ok: false },
      { _tag: 'mailFrom', ok: true },
      { _tag: 'mailFrom', ok: false },
      { _tag: 'recipientLocal', took: true },
      { _tag: 'recipientLocal', took: false },
      { _tag: 'recipientRemote', took: true },
      { _tag: 'recipientRemote', took: false },
      { _tag: 'rset' },
      { _tag: 'quit' },
    ]);
  });

  it('opens nothing before TLS under the strict policy, then takes credentials', () => {
    const greeted = greeting(3n);
    expect(greeted).toMatchObject({
      offers: true,
      strict: true,
      tls: false,
      stage: 'greeted',
    });

    // Strict: no envelope before encryption.
    const refused = step(greeted, { _tag: 'mailFrom', ok: true });
    expect(refused).toMatchObject({
      stage: 'greeted',
      sender: 'none',
      lastCode: 530n,
    });

    const secured = step(greeted, { _tag: 'starttls', ok: true });
    expect(secured).toMatchObject({
      tls: true,
      upgrades: 1n,
      stage: 'greeted',
      lastCode: 220n,
    });

    const authenticated = step(secured, { _tag: 'auth', ok: true });
    expect(authenticated).toMatchObject({ authed: true, lastCode: 235n });

    const enveloped = step(authenticated, { _tag: 'mailFrom', ok: true });
    expect(enveloped).toMatchObject({
      stage: 'envelope',
      sender: 'alice@elsewhere.example',
      lastCode: 250n,
    });
  });

  it('refuses credentials on an unencrypted session', () => {
    // An opportunistic MX that never upgraded: AUTH is still reachable, and it
    // is answered with 530 rather than tried.
    const greeted = greeting(1n);
    const early = step(greeted, { _tag: 'auth', ok: true });
    expect(early).toMatchObject({ authed: false, tls: false, lastCode: 530n });

    // And a bad credential over TLS is a rejection, not an acceptance.
    const secured = step(greeted, { _tag: 'starttls', ok: true });
    const wrong = step(secured, { _tag: 'auth', ok: false });
    expect(wrong).toMatchObject({ authed: false, tls: true, lastCode: 535n });

    // The invariant is real: accepted credentials without TLS are caught by name.
    expect(violatedInvariants(model, { ...early, authed: true })).toContain(
      'NoAuthBeforeTls',
    );
  });

  it('takes the two-step AUTH PLAIN, and only asks for the password over TLS', () => {
    // The bare form is legal (RFC 4954) and is what curl sends: `AUTH PLAIN`,
    // then the payload on the next line. It was answered 500 while being sent
    // exactly that, because the two-step spelling had no state.
    // Upgraded first: a submission client does not reach AUTH before TLS, and
    // the machine will not *ask* for a password before it either.
    const asked = step(step(greeting(3n), { _tag: 'starttls', ok: true }), {
      _tag: 'authStart',
    });
    expect(asked).toMatchObject({
      awaitingAuth: true,
      authed: false,
      lastCode: 334n,
    });

    const authenticated = step(asked, { _tag: 'authPayload', ok: true });
    expect(authenticated).toMatchObject({
      awaitingAuth: false,
      authed: true,
      lastCode: 235n,
    });

    // A payload nobody asked for is refused, not obeyed.
    const uninvited = step(greeting(1n), { _tag: 'authPayload', ok: true });
    expect(uninvited).toMatchObject({
      awaitingAuth: false,
      authed: false,
      lastCode: 503n,
    });
  });

  it('refuses to *ask* for the password in the clear, not just to accept it', () => {
    // An opportunistic MX that never upgraded: AUTH is reachable and answered
    // 530 rather than 334 — because the 334 is the server asking for the
    // password, and asking in the clear is the leak a later refusal cannot undo.
    const inTheClear = step(greeting(1n), { _tag: 'authStart' });
    expect(inTheClear).toMatchObject({
      awaitingAuth: false,
      tls: false,
      lastCode: 530n,
    });
    expect(
      violatedInvariants(model, { ...inTheClear, awaitingAuth: true }),
    ).toContain('AskingImpliesTls');

    // And a greeting or a reset discards one that was pending.
    const secured = step(greeting(1n), { _tag: 'starttls', ok: true });
    const pending = step(secured, { _tag: 'authStart' });
    expect(pending).toMatchObject({ awaitingAuth: true });
    expect(step(pending, { _tag: 'rset' })).toMatchObject({
      awaitingAuth: false,
    });
  });

  it('discards the transaction when the session upgrades', () => {
    // Opportunistic, so the envelope opened before TLS — which is exactly the
    // case RFC 3207 is about.
    const greeted = greeting(1n);
    const opened = step(greeted, { _tag: 'mailFrom', ok: true });
    expect(opened).toMatchObject({
      stage: 'envelope',
      sender: 'alice@elsewhere.example',
    });

    const upgraded = step(opened, { _tag: 'starttls', ok: true });
    expect(upgraded).toMatchObject({
      stage: 'greeted',
      sender: 'none',
      tls: true,
    });

    // The invariant is real: an envelope that survived the upgrade — the state
    // a server that forgot to reset would be in — is caught by name.
    expect(
      violatedInvariants(model, {
        ...upgraded,
        sender: 'alice@elsewhere.example',
        senderEpoch: 1n,
      }),
    ).toContain('EnvelopeFromThisEpoch');
  });

  it('upgrades at most once', () => {
    const secured = step(greeting(1n), { _tag: 'starttls', ok: true });
    const again = step(secured, { _tag: 'starttls', ok: true });
    expect(again).toMatchObject({ upgrades: 1n, tls: true, lastCode: 503n });
    expect(violatedInvariants(model, { ...again, upgrades: 2n })).toContain(
      'UpgradeAtMostOnce',
    );
  });

  it('takes a remote recipient only from a session it has authenticated', () => {
    // An MX: our own domain, from anybody, with no login involved at all.
    const greeted = greeting(1n);
    const opens = step(greeted, { _tag: 'mailFrom', ok: true });
    expect(step(opens, { _tag: 'recipientLocal', took: true })).toMatchObject({
      recipient: 'served',
      lastCode: 250n,
    });

    // The relay rule: somebody else's domain, nobody logged in. Refused — and this
    // is the line that would otherwise be `accepts: () => true`.
    // 554 is what the server actually answers (`RELAY_DENIED`), which this found
    // by disagreeing with it: the spec said 550 until a real submission was run
    // against the real server and the reply did not match.
    expect(step(opens, { _tag: 'recipientRemote', took: true })).toMatchObject({
      recipient: 'none',
      lastCode: 554n,
    });

    // After authenticating, the same recipient is taken: that is a relay.
    const secured = step(greeting(3n), { _tag: 'starttls', ok: true });
    const authed = step(secured, { _tag: 'auth', ok: true });
    const envelope = step(authed, { _tag: 'mailFrom', ok: true });
    const relayed = step(envelope, { _tag: 'recipientRemote', took: true });
    expect(relayed).toMatchObject({ recipient: 'remote', lastCode: 250n });

    // A reset empties the envelope, so the predicate is about the transaction and
    // not about the session's history.
    expect(step(relayed, { _tag: 'rset' })).toMatchObject({
      recipient: 'none',
    });

    // And the invariant is not decoration: a state that broke the rule fails it.
    expect(violatedInvariants(model, { ...relayed, authed: false })).toContain(
      'RemoteImpliesAuthed',
    );
  });

  it('does not un-authenticate a session when a later attempt fails', () => {
    // Authentication belongs to the *connection*. The model used to assign
    // `authed` on every AUTH, so a failed retry cleared it — and the relay
    // invariant above is what made that visible: a session that had already relayed
    // would have been holding an envelope it was no longer entitled to.
    const secured = step(greeting(3n), { _tag: 'starttls', ok: true });
    const authed = step(secured, { _tag: 'auth', ok: true });
    expect(authed['authed']).toBe(true);

    expect(step(authed, { _tag: 'auth', ok: false })).toMatchObject({
      authed: true,
      lastCode: 535n,
    });
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 50_000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['lastCode'] === 235n)).toBe(true);
    expect(report.reachable((state) => state['lastCode'] === 530n)).toBe(true);
    expect(report.reachable((state) => state['lastCode'] === 454n)).toBe(true);
    expect(report.reachable((state) => state['tls'] === true)).toBe(true);
    expect(report.reachable((state) => state['stage'] === 'closed')).toBe(true);
  });
});
