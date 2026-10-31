import { Data, Effect } from 'effect';
import {
  RevocationLog,
  type RevocationState,
  appendRevocation,
  initialRevocation,
  isRevoked,
  openEpoch,
  revokeCurrent,
} from './revocation.js';
import { describe, expect, it } from 'vitest';
import { grantRef } from './fixtures.js';

// Mirrors packages/specs/specs/space-host/revocation-log.qnt.

type Event = Data.TaggedEnum<{
  Grant: {};
  Revoke: {};
  Record: { readonly at: number };
}>;
const Event = Data.taggedEnum<Event>();

const AT_POOL = [0, 1, 2, 3] as const;
const EVENTS: ReadonlyArray<Event> = [
  Event.Grant(),
  Event.Revoke(),
  ...AT_POOL.map((at) => Event.Record({ at })),
];

const step = (state: RevocationState, event: Event): RevocationState =>
  Event.$match(event, {
    Grant: () => openEpoch(state),
    Revoke: () => revokeCurrent(state),
    Record: ({ at }) => appendRevocation(state, at),
  });

const invariants = (state: RevocationState) => ({
  forwardOnly: state.revokedUpTo <= state.epoch,
  revokedStaysRevoked:
    state.status !== 'revoked' || state.revokedUpTo === state.epoch,
  epochNonNegative: state.epoch >= 0,
  revocationNonNegative: state.revokedUpTo >= 0,
});

describe('revocation state (spec invariants)', () => {
  it('holds every invariant on every reachable state, and the pointer never moves back', () => {
    const MAX_DEPTH = 6;
    let frontier: ReadonlyArray<RevocationState> = [initialRevocation];
    let visited = 0;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      frontier = frontier.flatMap((state) =>
        EVENTS.map((event) => {
          const next = step(state, event);
          expect(next.revokedUpTo).toBeGreaterThanOrEqual(state.revokedUpTo);
          expect(Object.values(invariants(next)).every(Boolean)).toBe(true);
          return next;
        }),
      );
      visited += frontier.length;
    }
    expect(visited).toBeGreaterThan(1000);
  });

  it('a stale revocation record never rolls the pointer back', () => {
    let state = openEpoch(initialRevocation);
    expect(state).toMatchObject({ epoch: 1, status: 'active' });
    state = revokeCurrent(state);
    expect(state).toMatchObject({
      epoch: 1,
      revokedUpTo: 1,
      status: 'revoked',
    });

    state = openEpoch(state);
    expect(state).toMatchObject({ epoch: 2, revokedUpTo: 1, status: 'active' });

    const stale = appendRevocation(state, 1);
    expect(stale).toMatchObject({ epoch: 2, revokedUpTo: 1, status: 'active' });

    const current = appendRevocation(state, 2);
    expect(current).toMatchObject({
      epoch: 2,
      revokedUpTo: 2,
      status: 'revoked',
    });
  });

  it('a record never names a future or non-positive epoch', () => {
    const state = openEpoch(initialRevocation);
    expect(appendRevocation(state, 2)).toBe(state);
    expect(appendRevocation(state, 0)).toBe(state);
    expect(appendRevocation(state, -1)).toBe(state);
    expect(appendRevocation(initialRevocation, 1)).toBe(initialRevocation);
  });

  it('appending is idempotent and tolerates out-of-order arrival', () => {
    let state = initialRevocation;
    for (let i = 0; i < 3; i += 1) {
      state = openEpoch(state);
    }
    const once = appendRevocation(appendRevocation(state, 3), 1);
    const twice = appendRevocation(appendRevocation(once, 3), 1);
    expect(twice).toEqual(once);
    expect(once.revokedUpTo).toBe(3);
    expect(once.records).toEqual([1, 3]);
  });

  it('isRevoked covers every epoch up to the pointer', () => {
    const state = appendRevocation(openEpoch(openEpoch(initialRevocation)), 2);
    expect(isRevoked(state, 1)).toBe(true);
    expect(isRevoked(state, 2)).toBe(true);
    expect(isRevoked(state, 3)).toBe(false);
  });
});

describe('RevocationLog (in-memory)', () => {
  const run = <A, E>(program: Effect.Effect<A, E, RevocationLog>) =>
    Effect.runPromise(
      program.pipe(Effect.provide(RevocationLog.layerInMemory)),
    );

  it('keeps a separate log per grant and never lets one revoke another', async () => {
    const state = await run(
      Effect.gen(function* () {
        const log = yield* RevocationLog;
        const a = grantRef(1).uri;
        const b = grantRef(2).uri;
        yield* log.openEpoch(a);
        yield* log.openEpoch(b);
        yield* log.append(a, 1);
        return [yield* log.state(a), yield* log.state(b)] as const;
      }),
    );
    expect(state[0].status).toBe('revoked');
    expect(state[1].status).toBe('active');
  });

  it('openEpoch returns increasing epochs; re-append is a no-op', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* RevocationLog;
        const uri = grantRef(1).uri;
        const first = yield* log.openEpoch(uri);
        yield* log.append(uri, first);
        const second = yield* log.openEpoch(uri);
        const again = yield* log.append(uri, first);
        return { first, second, again };
      }),
    );
    expect(result.first).toBe(1);
    expect(result.second).toBe(2);
    expect(result.again).toMatchObject({ revokedUpTo: 1, status: 'active' });
  });
});
