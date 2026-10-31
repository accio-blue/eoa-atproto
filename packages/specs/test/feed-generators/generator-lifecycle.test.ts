import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/feed-generators/generator-lifecycle.model.generated.json';

// Spec-only verification for the feed-generator publishing lifecycle. The
// reference model IS the spec; no runtime is involved. Every step is checked
// for invariant violations, and the availability/accounting discipline gets
// explicit boundary coverage.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const text = (state: QuintModelValue, field: string) =>
  String(state[field] ?? '');
const number = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);
const flag = (state: QuintModelValue, field: string) => state[field] === true;

describe('generator lifecycle: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('feed_generators_generator_lifecycle');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StatusValid',
      'RecordLiveMatchesStatus',
      'AccountingExact',
      'NoServeBeforePublish',
      'PublishedHasVersion',
      'CountersNonNegative',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    // init seeds the initial state; it is not a step event
    const stepTags = definition.step.filter((tag) => tag !== 'init');
    expect(tags).toEqual(stepTags.sort());
    expect(events.length).toBeGreaterThan(stepTags.length);
  });
});

describe('generator lifecycle: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(
        simulate(model, { runs: 1, maxSteps: 250, seed }).violations,
      ).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 8, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(0);
  });

  it('record availability tracks status and every request is answered once', () => {
    const sessionEvents = eventsOf(model).filter(
      (event) => event._tag !== 'init',
    );
    let state = model.initial;
    const indexes = [...Array(400).keys()].map(
      (i) => (i * 43 + 13) % sessionEvents.length,
    );
    for (const index of indexes) {
      const event = sessionEvents[index];
      if (event === undefined) continue;
      state = model.transition(state, event);
      expect(violatedInvariants(model, state)).toEqual([]);
      expect(flag(state, 'recordLive')).toBe(
        text(state, 'status') === 'published',
      );
      expect(number(state, 'requests')).toBe(
        number(state, 'served') + number(state, 'rejected'),
      );
    }
  });
});

describe('generator lifecycle: boundary behavior', () => {
  it('a query before publish is rejected, then publish unlocks content', () => {
    let state = run([{ _tag: 'query' }]);
    expect({
      status: text(state, 'status'),
      requests: number(state, 'requests'),
      served: number(state, 'served'),
      rejected: number(state, 'rejected'),
    }).toEqual({
      status: 'draft',
      requests: 1n,
      served: 0n,
      rejected: 1n,
    });

    state = model.transition(state, { _tag: 'publish' });
    expect({
      status: text(state, 'status'),
      version: number(state, 'version'),
      live: flag(state, 'recordLive'),
      everPublished: flag(state, 'everPublished'),
    }).toEqual({
      status: 'published',
      version: 1n,
      live: true,
      everPublished: true,
    });

    state = model.transition(state, { _tag: 'query' });
    expect({
      requests: number(state, 'requests'),
      served: number(state, 'served'),
      rejected: number(state, 'rejected'),
    }).toEqual({ requests: 2n, served: 1n, rejected: 1n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('retire takes the record offline and restore brings it back with a new version', () => {
    let state = run([{ _tag: 'publish' }, { _tag: 'update', bump: 2n }]);
    expect(number(state, 'version')).toBe(3n);

    state = model.transition(state, { _tag: 'retire' });
    expect({
      status: text(state, 'status'),
      live: flag(state, 'recordLive'),
    }).toEqual({ status: 'retired', live: false });

    state = model.transition(state, { _tag: 'query' });
    expect({
      requests: number(state, 'requests'),
      served: number(state, 'served'),
      rejected: number(state, 'rejected'),
    }).toEqual({ requests: 1n, served: 0n, rejected: 1n });

    state = model.transition(state, { _tag: 'restore' });
    expect({
      status: text(state, 'status'),
      live: flag(state, 'recordLive'),
      version: number(state, 'version'),
    }).toEqual({ status: 'published', live: true, version: 4n });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        status: 'published',
        version: 1n,
        recordLive: true,
        everPublished: true,
        requests: 2n,
        served: 2n,
        rejected: 0n,
      }),
    ).toEqual([]);

    expect(
      violatedInvariants(model, {
        status: 'published',
        version: 1n,
        recordLive: false,
        everPublished: true,
        requests: 2n,
        served: 2n,
        rejected: 0n,
      }),
    ).toEqual(['RecordLiveMatchesStatus']);

    expect(
      violatedInvariants(model, {
        status: 'draft',
        version: 0n,
        recordLive: false,
        everPublished: false,
        requests: 1n,
        served: 1n,
        rejected: 0n,
      }),
    ).toEqual(['NoServeBeforePublish']);

    expect(
      violatedInvariants(model, {
        status: 'draft',
        version: 0n,
        recordLive: false,
        everPublished: true,
        requests: 0n,
        served: 0n,
        rejected: 0n,
      }),
    ).toEqual(['PublishedHasVersion']);
  });
});
