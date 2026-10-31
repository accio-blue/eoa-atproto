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
import definitionJson from '../../src/labeler/agent-attribution.model.generated.json';

// Spec-only verification of the agent-attribution label: a record authored by a
// DID that carries `ing.lexicon.agent.provenance` is flagged; a human author is
// never a subject of this label. The label is exactly the projection of the
// author's kind and provenance record - never authored independently.

const definition = decodeDefinition(definitionJson);
const model = makeReferenceModel(definition);

/** Step the reference model through a boundary sequence. */
const run = (events: ReadonlyArray<QuintEvent>): QuintModelValue =>
  events.reduce(
    (state, event) => model.transition(state, event),
    model.initial,
  );

const text = (state: QuintModelValue, field: string) => String(state[field]);

describe('labeler agent attribution: spec load', () => {
  it('decodes the generated model and exposes every declared invariant', () => {
    expect(definition.module).toBe('labeler_agent_attribution');
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'AuthorValid',
      'ProvenanceValid',
      'LabelValid',
      'LabelIsProjection',
      'VisibleImpliesAgent',
      'HumanUndecorated',
    ]);
  });

  it('the resolve pool expands over both author kinds', () => {
    const events = eventsOf(model);
    expect(
      events
        .filter((event) => event._tag === 'resolve')
        .map((event) => event['kind'])
        .sort(),
    ).toEqual(['agent', 'human']);
  });
});

describe('labeler agent attribution: invariants under exploration', () => {
  it('no invariant fails on any seeded random walk', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const { violations } = simulate(model, { runs: 1, maxSteps: 250, seed });
      expect(violations).toEqual([]);
    }
  });

  it('no invariant fails during breadth-first exploration', () => {
    const report = explore(model, { maxDepth: 10, maxStates: 5000 });
    expect(report.violations).toEqual([]);
    expect(report.states.length).toBeGreaterThan(1);
    expect(report.reachable((state) => state['label'] === 'visible')).toBe(
      true,
    );
    expect(report.reachable((state) => state['label'] === 'negated')).toBe(
      true,
    );
  });
});

describe('labeler agent attribution: boundary behavior', () => {
  it('an agent author with declared provenance projects a visible label', () => {
    const state = run([
      { _tag: 'resolve', kind: 'agent' },
      { _tag: 'declare' },
    ]);
    expect({
      author: text(state, 'author'),
      provenance: text(state, 'provenance'),
      label: text(state, 'label'),
    }).toEqual({ author: 'agent', provenance: 'declared', label: 'visible' });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('withdrawing the provenance record negates the label', () => {
    let state = run([
      { _tag: 'resolve', kind: 'agent' },
      { _tag: 'declare' },
      { _tag: 'withdraw' },
    ]);
    expect({
      provenance: text(state, 'provenance'),
      label: text(state, 'label'),
    }).toEqual({ provenance: 'withdrawn', label: 'negated' });
    expect(violatedInvariants(model, state)).toEqual([]);

    // re-projecting is idempotent
    state = model.transition(state, { _tag: 'reproject' });
    expect(stateKey(model, state)).toBe(
      stateKey(model, {
        author: 'agent',
        provenance: 'withdrawn',
        label: 'negated',
      }),
    );
  });

  it('a human author is never decorated', () => {
    const state = run([
      { _tag: 'resolve', kind: 'human' },
      { _tag: 'declare' },
    ]);
    expect({
      author: text(state, 'author'),
      label: text(state, 'label'),
    }).toEqual({ author: 'human', label: 'none' });
    expect(violatedInvariants(model, state)).toEqual([]);
  });

  it('invariants have teeth against a fabricated bad state', () => {
    expect(
      violatedInvariants(model, {
        author: 'agent',
        provenance: 'declared',
        label: 'visible',
      }),
    ).toEqual([]);

    // a visible label not backed by the projection
    expect(
      violatedInvariants(model, {
        author: 'agent',
        provenance: 'none',
        label: 'visible',
      }),
    ).toEqual(['LabelIsProjection']);

    // a human author decorated with the attribution label
    expect(
      violatedInvariants(model, {
        author: 'human',
        provenance: 'declared',
        label: 'visible',
      }),
    ).toEqual(['LabelIsProjection', 'VisibleImpliesAgent', 'HumanUndecorated']);
  });
});
