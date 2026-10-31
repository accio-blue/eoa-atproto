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
import definitionJson from '../../src/moderation/reply-window.model.generated.json';

// Spec-only verification for the moderation right of reply: a notice opens a
// window, the subject submits at most one reply, and the reply is published or
// rejected. The reference model IS the spec.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const field = (state: QuintModelValue, name: string) => String(state[name]);
const number = (state: QuintModelValue, name: string) =>
  BigInt(state[name] ?? 0n);

describe('moderation reply window: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('moderation_reply_window');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'NoticeValid',
      'WindowValid',
      'ReplyValid',
      'WindowNeedsNotice',
      'ReplyNeedsNotice',
      'RoundsBound',
      'RoundsTracksReply',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
  });
});

describe('moderation reply window: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, {
        runs: 1,
        maxSteps: 250,
        seed,
      });
      expect(violations).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 10, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('a reply never exists without the notice that opened its window', () => {
    const events = eventsOf(model);
    let state = model.initial;
    for (let index = 0; index < 300; index += 1) {
      const event = events[(index * 13 + 1) % events.length];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      if (field(state, 'reply') !== 'none') {
        expect(field(state, 'notice')).toBe('sent');
        expect(number(state, 'rounds')).toBe(1n);
      }
    }
  });
});

describe('moderation reply window: boundary behavior', () => {
  it('notify -> submit -> publish records exactly one reply', () => {
    let state = run([{ _tag: 'notify' }, { _tag: 'submit' }]);
    expect({
      notice: field(state, 'notice'),
      window: field(state, 'window'),
      reply: field(state, 'reply'),
      rounds: number(state, 'rounds'),
    }).toEqual({
      notice: 'sent',
      window: 'open',
      reply: 'submitted',
      rounds: 1n,
    });

    state = model.transition(state, { _tag: 'publish' });
    expect(field(state, 'reply')).toBe('published');
    expect(violatedInvariants(model, state)).toEqual([]);

    // a second submission is a no-op
    state = model.transition(state, { _tag: 'submit' });
    expect({
      reply: field(state, 'reply'),
      rounds: number(state, 'rounds'),
    }).toEqual({ reply: 'published', rounds: 1n });
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        notice: 'sent',
        window: 'open',
        reply: 'published',
        rounds: 1n,
      }),
    );
  });

  it('a lapsed window accepts no reply', () => {
    let state = run([{ _tag: 'notify' }, { _tag: 'expire' }]);
    expect(field(state, 'window')).toBe('expired');

    state = model.transition(state, { _tag: 'submit' });
    expect({
      reply: field(state, 'reply'),
      rounds: number(state, 'rounds'),
    }).toEqual({ reply: 'none', rounds: 0n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        notice: 'none',
        window: 'open',
        reply: 'submitted',
        rounds: 0n,
      }),
    ).toEqual(['WindowNeedsNotice', 'ReplyNeedsNotice', 'RoundsTracksReply']);
  });
});
