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
  simulate,
  stateKey,
} from '@quint-machine/core/testing';
import definitionJson from '../../src/notifications/delivery-lifecycle.model.generated.json';

// Spec-only verification for the notifications delivery / read-state machine:
// a notification is created, delivered over a push channel (retryable on
// failure), read, or withdrawn. Only a delivered notification counts as unread
// and a read one stays cleared. The reference model IS the spec.

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

describe('notifications delivery lifecycle: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('notifications_delivery_lifecycle');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StageValid',
      'UnreadBound',
      'UnreadOnlyWhenDelivered',
      'PushedImpliesAttempt',
      'ReadStaysCleared',
      'AttemptsNonNegative',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the deliver pool expands over its two outcomes
    expect(
      events
        .filter((event) => event._tag === 'deliver')
        .map((event) => event['ok'])
        .sort(),
    ).toEqual([false, true]);
  });
});

describe('notifications delivery lifecycle: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 250, seed });
      expect(violations).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 10, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('unread is only ever set by a delivery and clears on read', () => {
    const events = eventsOf(model);
    let state = model.initial;
    for (let index = 0; index < 300; index += 1) {
      const event = events[(index * 13 + 1) % events.length];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      if (number(state, 'unread') === 1n) {
        expect(stage(state)).toBe('delivered');
      }
    }
  });
});

describe('notifications delivery lifecycle: boundary behavior', () => {
  it('deliver -> read clears unread, and later events are no-ops', () => {
    let state = run([{ _tag: 'deliver', ok: true }]);
    expect({
      stage: stage(state),
      attempts: number(state, 'attempts'),
      unread: number(state, 'unread'),
      pushed: state['pushed'],
    }).toEqual({ stage: 'delivered', attempts: 1n, unread: 1n, pushed: true });

    state = model.transition(state, { _tag: 'read' });
    expect({ stage: stage(state), unread: number(state, 'unread') }).toEqual({
      stage: 'read',
      unread: 0n,
    });

    // a failed re-delivery and a withdrawal cannot resurrect a read one
    state = model.transition(state, { _tag: 'deliver', ok: false });
    state = model.transition(state, { _tag: 'withdraw' });
    expect({
      stage: stage(state),
      attempts: number(state, 'attempts'),
      unread: number(state, 'unread'),
    }).toEqual({ stage: 'read', attempts: 1n, unread: 0n });
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        stage: 'read',
        attempts: 1n,
        unread: 0n,
        pushed: true,
      }),
    );
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('a failed delivery retries, then withdrawal clears the unread flag', () => {
    let state = run([{ _tag: 'deliver', ok: false }]);
    expect({
      stage: stage(state),
      attempts: number(state, 'attempts'),
      pushed: state['pushed'],
    }).toEqual({ stage: 'failed', attempts: 1n, pushed: false });

    state = model.transition(state, { _tag: 'deliver', ok: true });
    expect({
      stage: stage(state),
      attempts: number(state, 'attempts'),
      unread: number(state, 'unread'),
    }).toEqual({ stage: 'delivered', attempts: 2n, unread: 1n });

    state = model.transition(state, { _tag: 'withdraw' });
    expect({ stage: stage(state), unread: number(state, 'unread') }).toEqual({
      stage: 'withdrawn',
      unread: 0n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        stage: 'delivered',
        attempts: 1n,
        unread: 1n,
        pushed: true,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        stage: 'zombie',
        attempts: -1n,
        unread: 2n,
        pushed: true,
      }),
    ).toEqual([
      'StageValid',
      'UnreadBound',
      'UnreadOnlyWhenDelivered',
      'PushedImpliesAttempt',
      'AttemptsNonNegative',
    ]);
  });
});
