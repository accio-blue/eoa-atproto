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
import definitionJson from '../../src/payments/refund-lifecycle.model.generated.json';

// Spec-only verification for the payments refund lifecycle: a refund can only
// be requested against a settled charge, at most one refund settles, a
// rejected refund may be retried, and a duplicate request is a no-op. The
// reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const stage = (state: QuintModelValue) => String(state['stage']);
const number = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('payments refund lifecycle: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('payments_refund_lifecycle');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StageValid',
      'RefundsBound',
      'RefundedHasRefund',
      'RejectedHasNoRefund',
      'RefundRequiresCharge',
      'RefundedRequiresCharge',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    expect(
      events
        .filter((event) => event._tag === 'processRefund')
        .map((event) => event['cleared'])
        .sort(),
    ).toEqual([false, true]);
  });
});

describe('payments refund lifecycle: invariants hold', () => {
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

  it('reaches a settled refund, and never more than one', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) => state['stage'] === 'refunded' && state['refunds'] === 1n,
      ),
    ).toBe(true);
    expect(report.reachable((state) => state['refunds'] === 2n)).toBe(false);
  });
});

describe('payments refund lifecycle: boundaries', () => {
  it('a refund needs a settled charge, then settles exactly once', () => {
    // no charge yet: the request is refused
    let state = run([{ _tag: 'requestRefund' }]);
    expect({ stage: stage(state), refunds: number(state, 'refunds') }).toEqual({
      stage: 'none',
      refunds: 0n,
    });

    state = model.transition(state, { _tag: 'settleCharge' });
    state = model.transition(state, { _tag: 'requestRefund' });
    expect(stage(state)).toBe('requested');

    state = model.transition(state, { _tag: 'processRefund', cleared: true });
    expect({ stage: stage(state), refunds: number(state, 'refunds') }).toEqual({
      stage: 'refunded',
      refunds: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);

    // a duplicate request is a no-op
    state = model.transition(state, { _tag: 'requestRefund' });
    expect({ stage: stage(state), refunds: number(state, 'refunds') }).toEqual({
      stage: 'refunded',
      refunds: 1n,
    });
    expect(stateKey(model, state)).toBe(
      stateKey(model, { stage: 'refunded', refunds: 1n, chargeSettled: true }),
    );
  });

  it('a rejected refund changes nothing and may be retried', () => {
    let state = run([
      { _tag: 'settleCharge' },
      { _tag: 'requestRefund' },
      { _tag: 'processRefund', cleared: false },
    ]);
    expect({ stage: stage(state), refunds: number(state, 'refunds') }).toEqual({
      stage: 'rejected',
      refunds: 0n,
    });

    state = model.transition(state, { _tag: 'retryRefund', cleared: true });
    expect({ stage: stage(state), refunds: number(state, 'refunds') }).toEqual({
      stage: 'refunded',
      refunds: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    expect(
      violatedInvariants(model, {
        stage: 'refunded',
        refunds: 0n,
        chargeSettled: true,
      }),
    ).toEqual(['RefundedHasRefund']);

    expect(
      violatedInvariants(model, {
        stage: 'rejected',
        refunds: 1n,
        chargeSettled: true,
      }),
    ).toEqual(['RejectedHasNoRefund']);

    expect(
      violatedInvariants(model, {
        stage: 'refunded',
        refunds: 1n,
        chargeSettled: false,
      }),
    ).toEqual(['RefundRequiresCharge', 'RefundedRequiresCharge']);

    expect(
      violatedInvariants(model, {
        stage: 'none',
        refunds: 2n,
        chargeSettled: false,
      }),
    ).toEqual(['RefundsBound']);
  });
});
