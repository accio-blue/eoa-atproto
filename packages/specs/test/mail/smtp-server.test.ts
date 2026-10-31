import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/mail/smtp-server.model.generated.json';

// Spec-only verification of the SMTP server (MX) envelope machine: the two rules
// that must never break — no open relay, and no `250` before the spool.
//
// `step` checks every declared invariant after every transition, so a reachable
// state that breaks one fails the test at the point it is reached rather than in
// a separate pass.

const model = makeReferenceModel(decodeDefinition(definitionJson));

const step = (state: typeof model.initial, event: Record<string, unknown>) => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

describe('mail: SMTP server envelope acceptance (spec-only)', () => {
  it('declares the MX invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StageValid',
      'RecipientIsOurs',
      'AcceptedImpliesDurable',
      'AcceptedImpliesRecipient',
      'QueuedIsDurable',
      'SenderImpliesGreeted',
      'DataImpliesRecipient',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'ehlo' },
      { _tag: 'mailFrom', ok: true },
      { _tag: 'mailFrom', ok: false },
      { _tag: 'rcptTo', asked: 'bob@org.example' },
      { _tag: 'rcptTo', asked: 'carol@other.example' },
      { _tag: 'data' },
      { _tag: 'spool', ok: true },
      { _tag: 'spool', ok: false },
      { _tag: 'accept' },
      { _tag: 'quit' },
    ]);
  });

  it('greets, takes a foreign sender and our recipient, and queues the message', () => {
    const greeted = step(model.initial, { _tag: 'ehlo' });
    expect(greeted).toMatchObject({
      stage: 'greeted',
      helo: true,
      lastCode: 250n,
    });

    // Anyone may send *to* us, so a foreign sender is normal.
    const enveloped = step(greeted, { _tag: 'mailFrom', ok: true });
    expect(enveloped).toMatchObject({
      stage: 'envelope',
      sender: 'alice@elsewhere.example',
      lastCode: 250n,
    });

    const addressed = step(enveloped, {
      _tag: 'rcptTo',
      asked: 'bob@org.example',
    });
    expect(addressed).toMatchObject({
      recipient: 'bob@org.example',
      lastCode: 250n,
    });

    const inData = step(addressed, { _tag: 'data' });
    expect(inData).toMatchObject({ stage: 'data', lastCode: 354n });

    const spooled = step(inData, { _tag: 'spool', ok: true });
    expect(spooled).toMatchObject({ durable: true, accepted: false });

    const queued = step(spooled, { _tag: 'accept' });
    expect(queued).toMatchObject({
      stage: 'queued',
      durable: true,
      accepted: true,
      lastCode: 250n,
    });
  });

  it('refuses a recipient we do not serve, and never stores it (no open relay)', () => {
    const greeted = step(model.initial, { _tag: 'ehlo' });
    const enveloped = step(greeted, { _tag: 'mailFrom', ok: true });

    const refused = step(enveloped, {
      _tag: 'rcptTo',
      asked: 'carol@other.example',
    });
    expect(refused).toMatchObject({
      recipient: 'none',
      stage: 'envelope',
      lastCode: 554n,
    });

    // DATA is then refused too: there is nobody we may deliver to.
    const noData = step(refused, { _tag: 'data' });
    expect(noData).toMatchObject({ stage: 'envelope', lastCode: 503n });

    // And the invariant is real: a stored foreign recipient is caught by name.
    expect(
      violatedInvariants(model, {
        ...noData,
        recipient: 'carol@other.example',
      }),
    ).toContain('RecipientIsOurs');
  });

  it('answers 4xx rather than 250 when accept is reached before the spool', () => {
    const greeted = step(model.initial, { _tag: 'ehlo' });
    const enveloped = step(greeted, { _tag: 'mailFrom', ok: true });
    const addressed = step(enveloped, {
      _tag: 'rcptTo',
      asked: 'bob@org.example',
    });
    const inData = step(addressed, { _tag: 'data' });

    // No spool has happened, so this must not be an acceptance.
    const early = step(inData, { _tag: 'accept' });
    expect(early).toMatchObject({
      durable: false,
      accepted: false,
      stage: 'data',
      lastCode: 451n,
    });

    // A failed spool abandons the transaction and asks the sender to retry.
    const failedSpool = step(inData, { _tag: 'spool', ok: false });
    expect(failedSpool).toMatchObject({
      durable: false,
      stage: 'envelope',
      lastCode: 451n,
    });

    // The invariant is real: an accepted-but-unspooled state is caught by name.
    expect(
      violatedInvariants(model, {
        ...inData,
        accepted: true,
        durable: false,
      }),
    ).toContain('AcceptedImpliesDurable');
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 50_000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['stage'] === 'queued')).toBe(true);
    expect(report.reachable((state) => state['lastCode'] === 554n)).toBe(true);
    expect(report.reachable((state) => state['lastCode'] === 451n)).toBe(true);
  });

  it('QUIT is always available, from every reachable state', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 50_000 });
    const closed = report.states.map((state) => step(state, { _tag: 'quit' }));
    expect(closed.length).toBeGreaterThan(1);
    expect(closed.every((state) => state['stage'] === 'closed')).toBe(true);
    expect(closed.every((state) => state['lastCode'] === 221n)).toBe(true);
  });
});
