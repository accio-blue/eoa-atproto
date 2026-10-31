import {
  type QuintEvent,
  type QuintModelValue,
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { eventsOf, explore, verifySpec } from '@quint-machine/core/testing';
import definitionJson from '../../src/backlink-index/link-extraction.model.generated.json';

// Spec-only verification for backlink-index link extraction: every observed
// record advances the ingest cursor, extracts its references and writes one
// index entry per reference under the referenced target. The reference model IS
// the spec; no machine implementation is involved.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

const step = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const mode = (state: QuintModelValue) => String(state['mode']);
const count = (state: QuintModelValue, field: string) =>
  BigInt(state[field] ?? 0n);
const text = (state: QuintModelValue, field: string) => String(state[field]);

describe('backlink link extraction: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('backlink_link_extraction');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'ModeValid',
      'CursorNonNegative',
      'CountsNonNegative',
      'IngestExact',
      'IndexExact',
      'LastTargetIsReference',
      'LastSourceIsReference',
    ]);
  });

  it('the spec pools cover every action in the step relation', () => {
    const events = eventsOf(model);
    const tags = [...new Set(events.map((event) => event._tag))].sort();
    expect(tags).toEqual(
      definition.step.filter((tag) => tag !== 'init').sort(),
    );
    // the scenario pool expands observe into one event per record shape
    expect(events.length).toBeGreaterThan(definition.step.length);
  });
});

describe('backlink link extraction: invariants hold under exploration', () => {
  it('no invariant fails on exploration or seeded random walks', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      expect(() =>
        verifySpec(model, {
          maxDepth: 8,
          maxStates: 4000,
          runs: 1,
          maxSteps: 200,
          seed,
        }),
      ).not.toThrow();
    }
  });

  it('reaches a live extractor that has indexed a reference', () => {
    const report = explore(model, { maxDepth: 6, maxStates: 4000 });
    expect(report.violations).toEqual([]);
    expect(
      report.reachable(
        (state) =>
          state['mode'] === 'live' &&
          BigInt(state['indexed'] ?? 0n) > 0n &&
          state['lastTarget'] !== 'none',
      ),
    ).toBe(true);
  });
});

describe('backlink link extraction: boundary behavior', () => {
  it('advances the ingest cursor once per record and indexes each reference', () => {
    let state = step([{ _tag: 'start' }]);
    expect(mode(state)).toBe('live');

    // a record carrying one reference
    state = model.transition(state, { _tag: 'observe', scenario: 1n });
    expect({
      cursor: count(state, 'cursor'),
      observed: count(state, 'observed'),
      extracted: count(state, 'extracted'),
      indexed: count(state, 'indexed'),
      lastTarget: text(state, 'lastTarget'),
    }).toEqual({
      cursor: 1n,
      observed: 1n,
      extracted: 1n,
      indexed: 1n,
      lastTarget: 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a',
    });

    // a record carrying no references: cursor advances, index does not
    state = model.transition(state, { _tag: 'observe', scenario: 0n });
    expect({
      cursor: count(state, 'cursor'),
      extracted: count(state, 'extracted'),
      lastTarget: text(state, 'lastTarget'),
    }).toEqual({
      cursor: 2n,
      extracted: 1n,
      lastTarget: 'at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a',
    });

    // a record carrying two references: both are indexed
    state = model.transition(state, { _tag: 'observe', scenario: 2n });
    expect({
      cursor: count(state, 'cursor'),
      extracted: count(state, 'extracted'),
      indexed: count(state, 'indexed'),
      lastSource: text(state, 'lastSource'),
    }).toEqual({
      cursor: 3n,
      extracted: 3n,
      indexed: 3n,
      lastSource: 'at://did:plc:genesis/app.bsky.feed.like/3jzsm4zqb2s2b',
    });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('records observed while idle do not advance the cursor or index', () => {
    let state = step([
      { _tag: 'start' },
      { _tag: 'observe', scenario: 1n },
      { _tag: 'pause' },
    ]);
    expect({ mode: mode(state), cursor: count(state, 'cursor') }).toEqual({
      mode: 'idle',
      cursor: 1n,
    });

    state = model.transition(state, { _tag: 'observe', scenario: 2n });
    expect({
      cursor: count(state, 'cursor'),
      observed: count(state, 'observed'),
      extracted: count(state, 'extracted'),
      indexed: count(state, 'indexed'),
    }).toEqual({ cursor: 1n, observed: 1n, extracted: 1n, indexed: 1n });
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        mode: 'zombie',
        cursor: -1n,
        observed: 0n,
        extracted: -1n,
        indexed: 0n,
        lastTarget: 'not-a-reference',
        lastSource: 'not-a-reference',
      }),
    ).toEqual([
      'ModeValid',
      'CursorNonNegative',
      'CountsNonNegative',
      'IngestExact',
      'IndexExact',
      'LastTargetIsReference',
      'LastSourceIsReference',
    ]);
  });
});
