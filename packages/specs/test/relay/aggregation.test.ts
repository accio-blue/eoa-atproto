import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/relay/aggregation.model.generated.json';

// Spec-only verification for the relay's aggregation + backfill machine: the
// relay's own output firehose, the durable consumer checkpoint, and replay.
// The checkpoint must never run ahead of the appended firehose.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const status = (state: QuintModelValue) => String(state['status']);
const number = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);

describe('relay aggregation: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('relay_aggregation');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StatusValid',
      'FeedNonNegative',
      'AckNeverAhead',
      'BackfillTargetWithinFeed',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    expect(events.length).toBeGreaterThan(definition.step.length);
  });
});

describe('relay aggregation: invariants hold under exploration', () => {
  const events = eventsOf(model);

  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(
        simulate(model, { runs: 1, maxSteps: 250, seed }).violations,
      ).toEqual([]);
    }
  });

  it('the firehose head never decreases and never trails its checkpoint', () => {
    // init starts a cold firehose (head resets to 0), so the monotonic
    // property is asserted over the running-firehose events only
    const runningEvents = events.filter((event) => event._tag !== 'init');
    let state = model.initial;
    let previousHead = number(state, 'feedSeq');
    const indexes = [...Array(500).keys()].map(
      (i) => (i * 41 + 5) % runningEvents.length,
    );
    for (const index of indexes) {
      const event = runningEvents[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      const head = number(state, 'feedSeq');
      expect(head >= previousHead).toBe(true);
      expect(number(state, 'ackSeq') <= head).toBe(true);
      expect(number(state, 'backfillTarget') <= head).toBe(true);
      previousHead = head;
    }
  });
});

describe('relay aggregation: boundary behavior', () => {
  it('acknowledgements clamp at the appended head', () => {
    let state = run([{ _tag: 'goLive' }, { _tag: 'appendBatch', n: 3n }]);
    expect({
      status: status(state),
      feedSeq: number(state, 'feedSeq'),
    }).toEqual({
      status: 'live',
      feedSeq: 3n,
    });

    // ask for more than exists: the checkpoint stops at the head
    state = model.transition(state, { _tag: 'ack', n: 5n });
    expect({
      ackSeq: number(state, 'ackSeq'),
      feedSeq: number(state, 'feedSeq'),
    }).toEqual({
      ackSeq: 3n,
      feedSeq: 3n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('backfill rewinds the checkpoint, replays to the target, then goes live', () => {
    let state = run([{ _tag: 'goLive' }, { _tag: 'appendBatch', n: 3n }]);

    state = model.transition(state, { _tag: 'startBackfill', from: 1n });
    expect({
      status: status(state),
      ackSeq: number(state, 'ackSeq'),
      backfillTarget: number(state, 'backfillTarget'),
    }).toEqual({ status: 'backfilling', ackSeq: 1n, backfillTarget: 3n });

    state = model.transition(state, { _tag: 'backfillAck', n: 1n });
    expect({
      status: status(state),
      ackSeq: number(state, 'ackSeq'),
    }).toEqual({ status: 'backfilling', ackSeq: 2n });

    // caught up to the snapshot head -> live, checkpoint never past it
    state = model.transition(state, { _tag: 'backfillAck', n: 1n });
    expect({
      status: status(state),
      ackSeq: number(state, 'ackSeq'),
    }).toEqual({ status: 'live', ackSeq: 3n });

    state = model.transition(state, { _tag: 'backfillAck', n: 3n });
    expect(number(state, 'ackSeq')).toBe(3n);
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        status: 'live',
        feedSeq: 5n,
        ackSeq: 3n,
        backfillTarget: 4n,
      }),
    ).toEqual([]);
    expect(
      violatedInvariants(model, {
        status: 'cold',
        feedSeq: -1n,
        ackSeq: 5n,
        backfillTarget: 9n,
      }),
    ).toEqual(['FeedNonNegative', 'AckNeverAhead', 'BackfillTargetWithinFeed']);
  });
});
