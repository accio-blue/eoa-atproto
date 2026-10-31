import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import {
  eventsOf,
  explore,
  stateKey,
  verifySpec,
} from '@quint-machine/core/testing';
import definitionJson from '../../src/payments/subscription-lifecycle.model.generated.json';

// Spec-only verification for the payments subscription lifecycle: a checkout
// intent settles to active, a declined renewal enters dunning, a repeated
// decline lapses, and a fresh intent starts unpaid. The reference model IS the
// spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const stage = (state: QuintModelValue) => String(state['state']);
const number = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('payments subscription lifecycle: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('payments_subscription_lifecycle');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StateValid',
      'ActiveImpliesPaid',
      'GraceImpliesPaid',
      'IntentUnpaid',
      'NoPaymentInAbsentState',
      'GraceHasFailure',
      'FailedRenewalsNonNegative',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // each settlement pool expands over both outcomes
    expect(
      events
        .filter((event) => event._tag === 'settleIntent')
        .map((event) => event['cleared'])
        .sort(),
    ).toEqual([false, true]);
  });
});

describe('payments subscription lifecycle: invariants hold', () => {
  it('no invariant fails on exploration or seeded random walks', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(() =>
        verifySpec(model, {
          maxDepth: 8,
          maxStates: 5000,
          runs: 1,
          maxSteps: 250,
          seed,
        }),
      ).not.toThrow();
    }
  });

  it('reaches active, dunning and lapsed, and never a paid absent state', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.reachable((state) => state['state'] === 'active')).toBe(true);
    expect(report.reachable((state) => state['state'] === 'grace')).toBe(true);
    expect(report.reachable((state) => state['state'] === 'lapsed')).toBe(true);
    expect(
      report.reachable(
        (state) => state['state'] === 'none' && state['paid'] === true,
      ),
    ).toBe(false);
  });
});

describe('payments subscription lifecycle: boundaries', () => {
  it('a cleared intent activates; a declined one returns to absent', () => {
    let state = run([{ _tag: 'beginIntent' }]);
    expect({
      state: stage(state),
      paid: state['paid'],
      failedRenewals: number(state, 'failedRenewals'),
    }).toEqual({ state: 'intent', paid: false, failedRenewals: 0n });

    state = model.transition(state, { _tag: 'settleIntent', cleared: true });
    expect({ state: stage(state), paid: state['paid'] }).toEqual({
      state: 'active',
      paid: true,
    });
    expect(violatedInvariants(model, state)).toEqual([]);

    const declined = run([
      { _tag: 'beginIntent' },
      { _tag: 'settleIntent', cleared: false },
    ]);
    expect({ state: stage(declined), paid: declined['paid'] }).toEqual({
      state: 'none',
      paid: false,
    });
    expect(violatedInvariants(model, declined)).toEqual([]);
  });

  it('a declined renewal duns, a repeated decline lapses, a retry clears', () => {
    let state = run([
      { _tag: 'beginIntent' },
      { _tag: 'settleIntent', cleared: true },
      { _tag: 'renew', cleared: false },
    ]);
    expect({
      state: stage(state),
      paid: state['paid'],
      failedRenewals: number(state, 'failedRenewals'),
    }).toEqual({ state: 'grace', paid: true, failedRenewals: 1n });

    state = model.transition(state, { _tag: 'retryRenewal', cleared: false });
    expect({
      state: stage(state),
      failedRenewals: number(state, 'failedRenewals'),
    }).toEqual({ state: 'lapsed', failedRenewals: 2n });
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        state: 'lapsed',
        paid: true,
        failedRenewals: 2n,
      }),
    );

    const recovered = run([
      { _tag: 'beginIntent' },
      { _tag: 'settleIntent', cleared: true },
      { _tag: 'renew', cleared: false },
      { _tag: 'retryRenewal', cleared: true },
    ]);
    expect({
      state: stage(recovered),
      failedRenewals: number(recovered, 'failedRenewals'),
    }).toEqual({ state: 'active', failedRenewals: 0n });
    expect(violatedInvariants(model, recovered)).toEqual([]);
  });

  it('cancelling keeps the settled cycle on record', () => {
    const state = run([
      { _tag: 'beginIntent' },
      { _tag: 'settleIntent', cleared: true },
      { _tag: 'cancel' },
    ]);
    expect({ state: stage(state), paid: state['paid'] }).toEqual({
      state: 'canceled',
      paid: true,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    expect(
      violatedInvariants(model, {
        state: 'active',
        paid: false,
        failedRenewals: 0n,
      }),
    ).toEqual(['ActiveImpliesPaid']);

    expect(
      violatedInvariants(model, {
        state: 'none',
        paid: true,
        failedRenewals: 0n,
      }),
    ).toEqual(['NoPaymentInAbsentState']);

    expect(
      violatedInvariants(model, {
        state: 'intent',
        paid: true,
        failedRenewals: 0n,
      }),
    ).toEqual(['IntentUnpaid']);

    expect(
      violatedInvariants(model, {
        state: 'zombie',
        paid: true,
        failedRenewals: -1n,
      }),
    ).toEqual(['StateValid', 'FailedRenewalsNonNegative']);
  });
});
