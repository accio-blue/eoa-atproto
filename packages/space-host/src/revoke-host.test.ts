import {
  ALICE,
  AUTHORITY,
  BOB,
  NOW,
  RUNS,
  SPACE,
  grantRef,
  stored,
} from './fixtures.js';
import { Decision, checkAccess } from './evaluate.js';
import { Effect, Layer } from 'effect';
import {
  HostStorage,
  RevokeIngestError,
  evaluatorLayersFromHost,
  ingestRevoke,
  revocationLogFromHost,
} from './host.js';
import { describe, expect, it } from 'vitest';
import { RevocationLog } from './revocation.js';

const run = Effect.runPromise;

const core = HostStorage.layerInMemory;
const layers = Layer.mergeAll(
  core,
  revocationLogFromHost.pipe(Layer.provide(core)),
  evaluatorLayersFromHost.pipe(Layer.provide(core)),
);

const revokeRecord = (overrides: Record<string, unknown> = {}) => ({
  grant: grantRef(1),
  revokedAt: '2026-10-04T12:00:00Z',
  ...overrides,
});

describe('revocation ingest over host storage', () => {
  it('maps a revoke strongRef to the grant epoch and revokes it', async () => {
    const state = await run(
      Effect.gen(function* () {
        const host = yield* HostStorage;
        const log = yield* RevocationLog;
        yield* host.putGrant(stored());
        yield* log.openEpoch(grantRef(1).uri);
        return yield* ingestRevoke({
          record: revokeRecord(),
          authority: AUTHORITY,
        });
      }).pipe(Effect.provide(layers)),
    );
    expect(state.revokedUpTo).toBe(1);
    expect(state.status).toBe('revoked');
  });

  it('is idempotent', async () => {
    const [first, second] = await run(
      Effect.gen(function* () {
        const host = yield* HostStorage;
        const log = yield* RevocationLog;
        yield* host.putGrant(stored());
        yield* log.openEpoch(grantRef(1).uri);
        const one = yield* ingestRevoke({
          record: revokeRecord(),
          authority: AUTHORITY,
        });
        const two = yield* ingestRevoke({
          record: revokeRecord(),
          authority: AUTHORITY,
        });
        return [one, two] as const;
      }).pipe(Effect.provide(layers)),
    );
    expect(second).toEqual(first);
    expect(first.records).toEqual([1]);
  });

  it('denies access once the grant is revoked', async () => {
    const decision = await run(
      Effect.gen(function* () {
        const host = yield* HostStorage;
        const log = yield* RevocationLog;
        yield* host.putGrant(stored());
        yield* log.openEpoch(grantRef(1).uri);
        yield* ingestRevoke({
          record: revokeRecord(),
          authority: AUTHORITY,
        });
        return yield* checkAccess({
          space: SPACE,
          did: ALICE,
          action: 'view',
          collection: RUNS,
          now: NOW,
        });
      }).pipe(Effect.provide(layers)),
    );
    expect(decision).toEqual(Decision.Deny({ reason: 'revoked' }));
  });

  it('refuses a revoke of a grant the host does not hold', async () => {
    const error = await run(
      Effect.gen(function* () {
        const host = yield* HostStorage;
        yield* host.putGrant(stored());
        return yield* ingestRevoke({
          record: revokeRecord({ grant: grantRef(2) }),
          authority: AUTHORITY,
        });
      }).pipe(Effect.flip, Effect.provide(layers)),
    );
    expect(error).toBeInstanceOf(RevokeIngestError);
    if (error instanceof RevokeIngestError) {
      expect(error.reason).toBe('unknown-grant');
    }
  });

  it('refuses a revoke from anyone but the space authority', async () => {
    const error = await run(
      Effect.gen(function* () {
        const host = yield* HostStorage;
        yield* host.putGrant(stored());
        return yield* ingestRevoke({
          record: revokeRecord(),
          authority: BOB,
        });
      }).pipe(Effect.flip, Effect.provide(layers)),
    );
    expect(error).toBeInstanceOf(RevokeIngestError);
    if (error instanceof RevokeIngestError) {
      expect(error.reason).toBe('not-authority');
    }
  });

  it('refuses a malformed revoke record', async () => {
    const error = await run(
      ingestRevoke({
        record: revokeRecord({ extra: true }),
        authority: AUTHORITY,
      }).pipe(Effect.flip, Effect.provide(layers)),
    );
    expect(error).toBeInstanceOf(RevokeIngestError);
    if (error instanceof RevokeIngestError) {
      expect(error.reason).toBe('decode');
    }
  });
});
