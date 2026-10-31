import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/video/transcode-job.model.generated.json';

// Spec-only verification for the video transcode job lifecycle. The generated
// reference model IS the spec; no machine implementation is involved. Every
// declared invariant is checked after every reachable step, and the
// queued/start/progress/finish/abort/requeue boundaries get explicit coverage.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const number = (state: QuintModelValue, field: string): bigint =>
  BigInt(String(state[field] ?? 0));

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

describe('video / transcode job lifecycle (spec-only)', () => {
  it('declares its invariants and starts queued with no progress', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'StageValid',
      'ProgressBound',
      'ProgressZeroWhenQueued',
      'ProgressFullWhenReady',
      'RunningProgressIncomplete',
      'AttemptsNonNegative',
      'FailuresNonNegative',
      'FailuresWithinAttempts',
      'RunningImpliesAttempt',
      'ReadyImpliesPlaylist',
      'PlaylistImpliesReady',
      'ReadyIsPlayable',
    ]);
    expect(model.initial).toMatchObject({
      stage: 'queued',
      attempts: 0n,
      failures: 0n,
      progress: 0n,
      playlist: false,
    });
  });

  it('derives the event alphabet from the spec pools', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // advance expands over its three progress increments
    expect(
      events
        .filter((event) => event._tag === 'advance')
        .map((event) => String(event['increment']))
        .sort(),
    ).toEqual(['10', '25', '50']);
  });

  it('holds every invariant on every explored and simulated state', () => {
    const exploration = explore(model, { maxDepth: 10, maxStates: 20_000 });
    expect(exploration.states.length).toBeGreaterThan(1);
    expect(exploration.violations).toEqual([]);
    expect(exploration.reachable((state) => state['stage'] === 'ready')).toBe(
      true,
    );
    expect(exploration.reachable((state) => state['stage'] === 'failed')).toBe(
      true,
    );
    // a ready job is always playback-ready (playlist published at 100)
    expect(
      exploration.reachable(
        (state) => state['stage'] === 'ready' && state['playlist'] === true,
      ),
    ).toBe(true);

    for (const seed of [1, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 300, seed });
      expect(violations).toEqual([]);
    }
  });

  it('boundary: a first attempt runs, advances, then finishes playable', () => {
    let state = run([{ _tag: 'start' }]);
    expect(state).toMatchObject({
      stage: 'running',
      attempts: 1n,
      failures: 0n,
      progress: 0n,
      playlist: false,
    });

    state = model.transition(state, { _tag: 'advance', increment: 25n });
    expect(state).toMatchObject({ stage: 'running', progress: 25n });
    expect(violatedInvariants(model, state)).toEqual([]);

    // progress never reaches 100 while running
    state = model.transition(state, { _tag: 'advance', increment: 50n });
    expect(state).toMatchObject({ stage: 'running', progress: 75n });

    state = model.transition(state, { _tag: 'finish' });
    expect(state).toMatchObject({
      stage: 'ready',
      progress: 100n,
      playlist: true,
      attempts: 1n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('boundary: a failed attempt requeues and retries from a clean slate', () => {
    let state = run([{ _tag: 'start' }, { _tag: 'advance', increment: 25n }]);
    expect(number(state, 'progress')).toBe(25n);

    state = model.transition(state, { _tag: 'abort' });
    expect(state).toMatchObject({
      stage: 'failed',
      attempts: 1n,
      failures: 1n,
      progress: 25n,
      playlist: false,
    });

    state = model.transition(state, { _tag: 'requeue' });
    expect(state).toMatchObject({ stage: 'queued', progress: 0n });

    state = model.transition(state, { _tag: 'start' });
    expect(state).toMatchObject({
      stage: 'running',
      attempts: 2n,
      failures: 1n,
      progress: 0n,
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('boundary: actions are no-ops outside their phase', () => {
    // advance/finish/abort do nothing while queued; requeue does nothing when
    // not failed.
    const advanced = model.transition(model.initial, {
      _tag: 'advance',
      increment: 50n,
    });
    expect(advanced).toMatchObject({ stage: 'queued', progress: 0n });
    const finished = model.transition(model.initial, { _tag: 'finish' });
    expect(finished).toMatchObject({ stage: 'queued', playlist: false });
    const aborted = model.transition(model.initial, { _tag: 'abort' });
    expect(aborted).toMatchObject({ stage: 'queued', failures: 0n });
    const requeued = model.transition(model.initial, { _tag: 'requeue' });
    expect(requeued).toMatchObject({ stage: 'queued' });
    expect(violatedInvariants(model, requeued)).toEqual([]);
  });

  it('invariants have teeth against fabricated bad states', () => {
    // a "ready" job with no playlist and partial progress is impossible
    expect(
      violatedInvariants(model, {
        stage: 'ready',
        attempts: 1n,
        failures: 0n,
        progress: 40n,
        playlist: false,
      }),
    ).toEqual([
      'ProgressFullWhenReady',
      'ReadyImpliesPlaylist',
      'ReadyIsPlayable',
    ]);

    // a playlist without readiness, leftover progress while queued, and more
    // failures than attempts
    expect(
      violatedInvariants(model, {
        stage: 'queued',
        attempts: 0n,
        failures: 1n,
        progress: 20n,
        playlist: true,
      }),
    ).toEqual([
      'ProgressZeroWhenQueued',
      'FailuresWithinAttempts',
      'PlaylistImpliesReady',
    ]);

    // a running job must have a started attempt and unfinished progress
    expect(
      violatedInvariants(model, {
        stage: 'running',
        attempts: 0n,
        failures: 0n,
        progress: 100n,
        playlist: false,
      }),
    ).toEqual(['RunningProgressIncomplete', 'RunningImpliesAttempt']);
  });
});
