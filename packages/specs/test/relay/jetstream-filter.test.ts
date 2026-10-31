import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/relay/jetstream-filter.model.generated.json';

// Spec-only verification for the Jetstream variant: the relay firehose
// projected through a collection filter. Every observed record is accounted
// for exactly once — emitted or dropped.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const status = (state: QuintModelValue) => String(state['status']);
const count = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);
const accounting = (state: QuintModelValue) =>
  `${count(state, 'seen')}/${count(state, 'matched')}/${count(state, 'dropped')}`;

describe('relay jetstream filter: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('relay_jetstream_filter');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StatusValid',
      'CountsNonNegative',
      'AccountingExact',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the collection pool expands one record event per collection
    expect(events.length).toBeGreaterThan(definition.step.length);
  });
});

describe('relay jetstream filter: invariants hold under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(
        simulate(model, { runs: 1, maxSteps: 250, seed }).violations,
      ).toEqual([]);
    }
  });
});

describe('relay jetstream filter: boundary behavior', () => {
  it('matching records are emitted, others dropped, accounting stays exact', () => {
    let state = run([{ _tag: 'start' }]);
    expect(status(state)).toBe('streaming');

    state = model.transition(state, {
      _tag: 'record',
      collection: 'app.bsky.feed.post',
    });
    expect(accounting(state)).toBe('1/1/0');

    state = model.transition(state, {
      _tag: 'record',
      collection: 'app.bsky.graph.follow',
    });
    expect(accounting(state)).toBe('2/1/1');

    state = model.transition(state, {
      _tag: 'record',
      collection: 'com.atproto.label',
    });
    expect(accounting(state)).toBe('3/1/2');
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('records observed while paused are not accounted at all', () => {
    let state = run([
      { _tag: 'start' },
      { _tag: 'record', collection: 'app.bsky.feed.post' },
      { _tag: 'pause' },
    ]);
    expect({ status: status(state), accounting: accounting(state) }).toEqual({
      status: 'paused',
      accounting: '1/1/0',
    });

    state = model.transition(state, {
      _tag: 'record',
      collection: 'app.bsky.feed.post',
    });
    expect(accounting(state)).toBe('1/1/0');

    state = model.transition(state, { _tag: 'resume' });
    state = model.transition(state, {
      _tag: 'record',
      collection: 'app.bsky.actor.profile',
    });
    expect(accounting(state)).toBe('2/1/1');
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        status: 'streaming',
        seen: 3n,
        matched: 2n,
        dropped: 1n,
      }),
    ).toEqual([]);
    expect(
      violatedInvariants(model, {
        status: 'zombie',
        seen: 3n,
        matched: -1n,
        dropped: 5n,
      }),
    ).toEqual(['StatusValid', 'CountsNonNegative', 'AccountingExact']);
  });
});
