import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore } from '@quint-machine/core/testing';
import definitionJson from '../../src/mail/outbound-queue.model.generated.json';

// Spec-only verification of the outbound queue: the retry schedule, delivery
// once, and a permanent failure becoming a DSN.
//
// The schedule is comail's — 1, 5, 15, 30, 60 minutes, five attempts — and it is
// the reason this is a machine rather than a loop: "how long do we wait" is a
// policy, and a policy belongs somewhere it can be read and disagreed with.

const model = makeReferenceModel(decodeDefinition(definitionJson));

const step = (state: typeof model.initial, event: Record<string, unknown>) => {
  const next = model.transition(state, event);
  expect(violatedInvariants(model, next)).toEqual([]);
  return next;
};

/** Time passing until `minute`, one tick at a time. */
const walkTo = (state: typeof model.initial, minute: bigint) =>
  Array.from({ length: Number(minute - (state['now'] as bigint)) }).reduce<
    typeof model.initial
  >((held) => step(held, { _tag: 'tick' }), state);

describe('mail: the outbound queue (spec-only)', () => {
  it('declares the queue invariants (spec-derived, no hand list)', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StateValid',
      'AttemptsBounded',
      'DeliveredIsFinal',
      'AttemptOnlyWhenDue',
      'BouncedIsReported',
      'DeliveredWasAttempted',
    ]);
  });

  it('derives the event alphabet from the spec pools and event schemas', () => {
    expect(eventsOf(model)).toEqual([
      { _tag: 'tick' },
      { _tag: 'attempt', answer: 250n },
      { _tag: 'attempt', answer: 451n },
      { _tag: 'attempt', answer: 550n },
      { _tag: 'giveUp' },
    ]);
  });

  it('backs off on the schedule: 1, 5, 15, 30, 60 minutes', () => {
    // Five deferrals, each preceded by waiting exactly as long as was promised.
    const held = [1, 2, 3, 4, 5].reduce<{
      readonly state: typeof model.initial;
      readonly waits: ReadonlyArray<bigint>;
    }>(
      (held) => {
        const deferred = step(held.state, { _tag: 'attempt', answer: 451n });
        const wait =
          (deferred['dueAt'] as bigint) - (deferred['now'] as bigint);
        return {
          state: walkTo(deferred, deferred['dueAt'] as bigint),
          waits: [...held.waits, wait],
        };
      },
      { state: model.initial, waits: [] },
    );

    expect(held.waits).toEqual([1n, 5n, 15n, 30n, 60n]);
    // And after five, an attempt is no longer allowed — the message is exhausted
    // rather than retried forever.
    expect(held.state['attempts']).toBe(5n);
  });

  it('delivers once, and a permanent failure is a DSN', () => {
    const deferred = walkTo(
      step(model.initial, { _tag: 'attempt', answer: 451n }),
      1n,
    );
    const delivered = step(deferred, { _tag: 'attempt', answer: 250n });
    expect(delivered).toMatchObject({
      state: 'delivered',
      everDelivered: true,
      lastCode: 250n,
    });

    // A delivery is final: nothing moves it, and the invariant says so.
    const again = step(delivered, { _tag: 'attempt', answer: 451n });
    expect(again).toMatchObject({ state: 'delivered', everDelivered: true });
    expect(violatedInvariants(model, { ...again, state: 'spooled' })).toContain(
      'DeliveredIsFinal',
    );

    // And a 5xx is a bounce with a report, not a silence.
    const refused = step(model.initial, { _tag: 'attempt', answer: 550n });
    expect(refused).toMatchObject({ state: 'bounced', dsn: true });
    expect(violatedInvariants(model, { ...refused, dsn: false })).toContain(
      'BouncedIsReported',
    );

    // Exhaustion is the same outcome: five attempts, then somebody hears.
    const spent = [1, 2, 3, 4, 5].reduce<typeof model.initial>((state) => {
      const deferredAgain = step(state, { _tag: 'attempt', answer: 451n });
      return walkTo(deferredAgain, deferredAgain['dueAt'] as bigint);
    }, model.initial);
    const givenUp = step(spent, { _tag: 'giveUp' });
    expect(givenUp).toMatchObject({ state: 'bounced', dsn: true });
  });

  it('holds every invariant on every reachable state', () => {
    const report = explore(model, { maxDepth: 40, maxStates: 60_000 });
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['state'] === 'delivered')).toBe(
      true,
    );
    expect(report.reachable((state) => state['state'] === 'bounced')).toBe(
      true,
    );
  });
});
