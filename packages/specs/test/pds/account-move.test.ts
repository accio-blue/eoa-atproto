import {
  decodeDefinition,
  makeReferenceModel,
  violatedInvariants,
} from '@quint-machine/core';
import { describe, expect, it } from 'vitest';
import { explore, simulate } from '@quint-machine/core/testing';
import definitionJson from '../../src/pds/account-move.model.generated.json';

/**
 * The move spec on its own: the state space it declares, and the invariants it declares are checked
 * after every step. `@eoa/atproto-move` is the other half — the runtime this rule is about.
 */

const model = makeReferenceModel(decodeDefinition(definitionJson));

/**
 * A type alias, not an interface: `QuintModelValue` is an index signature, and
 * only an object-literal alias gets an implicit one. As an interface the state
 * is a closed shape and `model.transition` refuses it.
 */
type MoveState = {
  readonly phase: string;
  readonly advanced: bigint;
  readonly spaces: boolean;
  readonly discovered: boolean;
};

/** A state that has discovered its spaces: what every step below starts from. */
const after = (
  state: Omit<MoveState, 'discovered'>,
  discovered = true,
): MoveState => ({ ...state, discovered });

/** One draw of the spec's `advance`, against a state we choose. */
const advance = (fields: MoveState, target: string) =>
  model.transition(fields, { _tag: 'advance', target });

describe('pds account move (spec-only)', () => {
  it('generated model carries the spec-declared invariants', () => {
    expect(model.invariants.map((invariant) => invariant.name)).toEqual([
      'PhaseKnown',
      'AdvancedAtMostSeven',
      'AdvancedImpliesStarted',
      'AdvancedImpliesDiscovered',
      'NoSpacesStaysFive',
      'SpacesPhasesNeedSpaces',
      'ActiveIsTheLastStep',
    ]);
  });

  it('invariants hold across seeded random event sequences', () => {
    const report = simulate(model, {
      runs: 300,
      maxSteps: 40,
      seed: 0xacc0_0002,
    });
    expect(report.violations).toEqual([]);
  });

  it('invariants hold across the bounded exhaustive event space', () => {
    const report = explore(model, { maxDepth: 9, maxStates: 400_000 });
    expect(report.violations).toEqual([]);
  });

  it('invariants have teeth', () => {
    expect(
      violatedInvariants(
        model,
        after({ phase: 'created', advanced: 0n, spaces: false }),
      ),
    ).toEqual([]);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'active', advanced: 5n, spaces: false }),
      ),
    ).toEqual([]);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'active', advanced: 7n, spaces: true }),
      ),
    ).toEqual([]);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'bogus', advanced: 0n, spaces: false }),
      ),
    ).toEqual(['PhaseKnown']);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'created', advanced: 3n, spaces: false }),
      ),
    ).toEqual(['AdvancedImpliesStarted']);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'repo', advanced: 1n, spaces: false }, false),
      ),
    ).toEqual(['AdvancedImpliesDiscovered']);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'active', advanced: 5n, spaces: true }),
      ),
    ).toEqual(['ActiveIsTheLastStep']);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'identity', advanced: 8n, spaces: true }),
      ),
    ).toEqual(['AdvancedAtMostSeven']);
    // The promise an ordinary move is kept at: no spaces, five steps, and neither space phase.
    expect(
      violatedInvariants(
        model,
        after({ phase: 'identity', advanced: 6n, spaces: false }),
      ),
    ).toEqual(['NoSpacesStaysFive']);
    expect(
      violatedInvariants(
        model,
        after({ phase: 'space-meta', advanced: 4n, spaces: false }),
      ),
    ).toEqual(['SpacesPhasesNeedSpaces']);
  });

  it('boundary: a step forward is the next phase, and it counts', () => {
    const moved = advance(
      after({ phase: 'created', advanced: 0n, spaces: false }),
      'repo',
    );
    expect(moved).toMatchObject({ phase: 'repo', advanced: 1n });
    expect(violatedInvariants(model, moved)).toEqual([]);
  });

  it('boundary: nothing advances before the source has said what it has', () => {
    // The move asks `listSpaces` before it writes anything, and a step drawn before that answer is a
    // step that did not happen.
    const early = advance(
      after({ phase: 'created', advanced: 0n, spaces: false }, false),
      'repo',
    );
    expect(early).toMatchObject({ phase: 'created', advanced: 0n });

    const discovered = model.transition(early, {
      _tag: 'discover',
      hasSpaces: true,
    });
    expect(discovered).toMatchObject({ spaces: true, discovered: true });
    expect(violatedInvariants(model, discovered)).toEqual([]);
  });

  it('boundary: a step that skips is not taken', () => {
    // The rule's teeth: `created` cannot reach `blobs` in one draw, so the draw is a step that did
    // not happen rather than a phase that moved too far.
    const skipped = advance(
      after({ phase: 'created', advanced: 0n, spaces: false }),
      'blobs',
    );
    expect(skipped).toMatchObject({ phase: 'created', advanced: 0n });
    expect(violatedInvariants(model, skipped)).toEqual([]);
  });

  it('boundary: the spaces pair is taken only by an account with spaces', () => {
    const withSpaces = advance(
      after({ phase: 'prefs', advanced: 3n, spaces: true }),
      'space-meta',
    );
    expect(withSpaces).toMatchObject({ phase: 'space-meta', advanced: 4n });

    const without = advance(
      after({ phase: 'prefs', advanced: 3n, spaces: false }),
      'space-meta',
    );
    expect(without).toMatchObject({ phase: 'prefs', advanced: 3n });

    // The other branch: no spaces goes straight to the handover, and a spaces move cannot.
    const straight = advance(
      after({ phase: 'prefs', advanced: 3n, spaces: false }),
      'identity',
    );
    expect(straight).toMatchObject({ phase: 'identity', advanced: 4n });

    const skipped = advance(
      after({ phase: 'prefs', advanced: 3n, spaces: true }),
      'identity',
    );
    expect(skipped).toMatchObject({ phase: 'prefs', advanced: 3n });
  });

  it('boundary: a step backwards is not taken, and the end is the end', () => {
    const backwards = advance(
      after({ phase: 'identity', advanced: 4n, spaces: false }),
      'repo',
    );
    expect(backwards).toMatchObject({ phase: 'identity', advanced: 4n });

    const finished = advance(
      after({ phase: 'active', advanced: 5n, spaces: false }),
      'active',
    );
    expect(finished).toMatchObject({ phase: 'active', advanced: 5n });
    expect(violatedInvariants(model, finished)).toEqual([]);
  });
});
