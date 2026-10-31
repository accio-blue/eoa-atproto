import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/mail/warming.model.generated.json';

// Spec-only verification of warming: the caps that keep a new member from spending
// the pool's reputation, and the pause that stops a domain when its rates say
// something has gone wrong.

const model = makeReferenceModel(decodeDefinition(definitionJson));

const step = (state: typeof model.initial, event: Record<string, unknown>) => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

/** A run of sends with the outcomes named, rather than one call per line. */
const sends = (state: typeof model.initial, outcomes: ReadonlyArray<string>) =>
  outcomes.reduce<typeof model.initial>(
    (held, outcome) => step(held, { _tag: 'send', outcome }),
    state,
  );

const days = (state: typeof model.initial, count: number) =>
  Array.from({ length: count }).reduce<typeof model.initial>(
    (held) => step(held, { _tag: 'advanceDay' }),
    state,
  );

describe('mail: warming and reputation (spec-only)', () => {
  it('declares the warming invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'WithinHourlyCap',
      'WithinDailyCap',
      'PausedIsSilent',
      'PromotedNotEarly',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'send', outcome: 'delivered' },
      { _tag: 'send', outcome: 'bounced' },
      { _tag: 'send', outcome: 'complained' },
      { _tag: 'advanceHour' },
      { _tag: 'advanceDay' },
      { _tag: 'promote' },
      { _tag: 'resume' },
    ]);
  });

  it('stops a new domain at two an hour, however willing it is', () => {
    // Three sends, two of them accepted: the third is refused, which is the
    // invariant the epic names — a new member cannot spend the pool's reputation,
    // because the pool's reputation *is* the domain's.
    const held = sends(model.initial, ['delivered', 'delivered', 'delivered']);

    expect(held['sendsHour']).toBe(2n);
    expect(held['sent']).toBe(2n);
    expect(held['delivered']).toBe(2n);

    // An hour later the allowance is restored, because it is a rate and not a
    // budget for the day.
    const nextHour = step(held, { _tag: 'advanceHour' });
    expect(sends(nextHour, ['delivered'])['sendsHour']).toBe(1n);
  });

  it('pauses the domain when a bounce crosses the threshold, and stays silent', () => {
    // One of two bounced: 50%, and the threshold is 5%.
    const paused = sends(model.initial, ['delivered', 'bounced']);

    expect(paused['paused']).toBe(true);
    expect(paused['sent']).toBe(2n);
    expect(paused['sentWhenPaused']).toBe(2n);
    expect(paused['bounces']).toBe(1n);

    // A pause is not a sentiment: nothing leaves while it is on, even a send the
    // caps would otherwise have allowed.
    const during = sends(paused, ['delivered', 'delivered', 'delivered']);
    expect(during['sent']).toBe(2n);
    expect(during['sendsHour']).toBe(2n);

    // And it does not lift on its own when the window rolls over: the rates reset,
    // the reason does not, and what went wrong is somebody's to fix.
    expect(step(paused, { _tag: 'advanceDay' })['paused']).toBe(true);

    // Only a person lifts it. In the same hour the *cap* then refuses the send,
    // which is right and is not a pause: the reason is now the rate, not the stop.
    const resumed = step(paused, { _tag: 'resume' });
    expect(resumed['paused']).toBe(false);
    expect(sends(resumed, ['delivered'])['sent']).toBe(2n);

    // An hour later the domain sends again.
    const nextHour = step(resumed, { _tag: 'advanceHour' });
    expect(sends(nextHour, ['delivered'])['sent']).toBe(3n);
  });

  it('pauses on a complaint rate too, which is a person and not a server', () => {
    // 8 in 10,000 is 0.08%: one complaint in a hundred delivered messages is over
    // it, and a hundred is a plausible day for a warmed domain.
    const held = sends(model.initial, ['delivered', 'complained']);

    expect(held['paused']).toBe(true);
    expect(held['complaints']).toBe(1n);
  });

  it('promotes on time and not on wanting it', () => {
    // A week has not passed, so asking changes nothing.
    const early = step(model.initial, { _tag: 'promote' });
    expect(early['tier']).toBe('new');
    expect(early['week']).toBe(1n);

    const afterAWeek = step(days(model.initial, 7), { _tag: 'promote' });
    expect(afterAWeek['tier']).toBe('warmed');
    expect(afterAWeek['week']).toBe(2n);

    // And the caps moved with it: five sends in an hour are all accepted, where the
    // new tier refused the third.
    const busy = sends(afterAWeek, [
      'delivered',
      'delivered',
      'delivered',
      'delivered',
      'delivered',
    ]);
    expect(busy['sendsHour']).toBe(5n);
    expect(busy['delivered']).toBe(5n);
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 30, maxStates: 80_000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    // Both ends of it are reachable: a domain that got stopped, and one that got
    // through the week.
    expect(report.reachable((state) => state['paused'] === true)).toBe(true);
    expect(report.reachable((state) => state['tier'] === 'warmed')).toBe(true);
  });
});
