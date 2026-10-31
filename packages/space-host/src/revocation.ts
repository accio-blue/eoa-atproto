import { Context, Effect, Layer, Ref } from 'effect';
import type { ATURI } from '@eoa/core';
import type { LookupError } from './grant.js';

/**
 * Revocation as an append-only, forward-only log - mirrors
 * `packages/specs/specs/space-host/revocation-log.qnt`.
 *
 * Revoke records are appended (possibly out of order). The effective
 * revocation is `revokedUpTo`, the highest revoked epoch: it only moves
 * forward and never names an epoch the grant has not reached. A grant opens a
 * new epoch, so a stale record for an old epoch cannot revoke - or roll back -
 * the current one.
 */
export interface RevocationState {
  /** Current grant epoch (0 = no grant yet). */
  readonly epoch: number;
  /** Highest revoked epoch: the append-only pointer. */
  readonly revokedUpTo: number;
  readonly status: 'none' | 'active' | 'revoked';
  /** Accepted revoke records (distinct epochs, ascending). Append-only. */
  readonly records: ReadonlyArray<number>;
}

export const initialRevocation: RevocationState = {
  epoch: 0,
  revokedUpTo: 0,
  status: 'none',
  records: [],
};

/** A (re-)grant opens a new epoch; earlier revocations stand. */
export const openEpoch = (state: RevocationState): RevocationState => ({
  ...state,
  epoch: state.epoch + 1,
  status: 'active',
});

/**
 * Append a revoke record naming epoch `at`. Idempotent. A record for a future
 * (or non-positive) epoch is not accepted; a stale one is logged but cannot
 * move the pointer back.
 */
export const appendRevocation = (
  state: RevocationState,
  at: number,
): RevocationState => {
  if (!Number.isInteger(at) || at < 1 || at > state.epoch) {
    return state;
  }
  const records = state.records.includes(at)
    ? state.records
    : [...state.records, at].sort((a, b) => a - b);
  const advances = at > state.revokedUpTo;
  return {
    ...state,
    records,
    revokedUpTo: advances ? at : state.revokedUpTo,
    status: advances && at === state.epoch ? 'revoked' : state.status,
  };
};

/** Revoke whatever epoch is current (the spec's `revoke` action). */
export const revokeCurrent = (state: RevocationState): RevocationState =>
  state.status === 'active' ? appendRevocation(state, state.epoch) : state;

/** A grant issued in `epoch` is dead once the pointer has reached it. */
export const isRevoked = (state: RevocationState, epoch: number): boolean =>
  epoch <= state.revokedUpTo;

/**
 * Per-grant revocation log, keyed by the grant's at-uri. The storage backend is
 * a seam: this interface is all `checkAccess` depends on.
 */
export class RevocationLog extends Context.Service<
  RevocationLog,
  {
    /** A (re-)grant: open a new epoch and return it. */
    readonly openEpoch: (grant: ATURI) => Effect.Effect<number, LookupError>;
    /** Append a revoke record naming `epoch`; idempotent, forward-only. */
    readonly append: (
      grant: ATURI,
      epoch: number,
    ) => Effect.Effect<RevocationState, LookupError>;
    readonly state: (
      grant: ATURI,
    ) => Effect.Effect<RevocationState, LookupError>;
  }
>()('@eoa/space-host/RevocationLog') {
  static readonly layerInMemory = Layer.effect(
    RevocationLog,
    Effect.gen(function* () {
      const logs = yield* Ref.make<ReadonlyMap<ATURI, RevocationState>>(
        new Map(),
      );

      const update = (
        grant: ATURI,
        step: (state: RevocationState) => RevocationState,
      ) =>
        Ref.modify(logs, (all) => {
          const next = step(all.get(grant) ?? initialRevocation);
          return [next, new Map(all).set(grant, next)] as const;
        });

      return RevocationLog.of({
        openEpoch: (grant) =>
          update(grant, openEpoch).pipe(Effect.map((state) => state.epoch)),
        append: (grant, epoch) =>
          update(grant, (state) => appendRevocation(state, epoch)),
        state: (grant) =>
          Ref.get(logs).pipe(
            Effect.map((all) => all.get(grant) ?? initialRevocation),
          ),
      });
    }),
  );
}
