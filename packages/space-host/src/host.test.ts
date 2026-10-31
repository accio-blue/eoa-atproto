import {
  ALICE,
  AUTHORITY,
  BOB,
  NOW,
  ROLE,
  RUNS,
  SPACE,
  cid,
  grantRef,
  member,
  nsid,
} from './fixtures.js';
import { Decision, checkAccess } from './evaluate.js';
import { Effect, Layer } from 'effect';
import {
  GrantIngestError,
  HostStorage,
  evaluatorLayersFromHost,
  ingestGrant,
  lensStatusOf,
} from './host.js';
import { describe, expect, it } from 'vitest';
import { RevocationLog } from './revocation.js';

const run = Effect.runPromise;
const LENS = nsid('ing.lexicon.lens.post');
const PINNED = cid('bafypinned');
const CURRENT = cid('bafycurrent');

const record = (overrides: Record<string, unknown> = {}) => ({
  space: SPACE,
  subject: ALICE,
  selectors: [{ collection: RUNS }],
  actions: ['view'],
  issuedBy: AUTHORITY,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const layers = Layer.mergeAll(
  evaluatorLayersFromHost.pipe(Layer.provideMerge(HostStorage.layerInMemory)),
  RevocationLog.layerInMemory,
);

const access = (did = ALICE) =>
  Effect.gen(function* () {
    const log = yield* RevocationLog;
    yield* log.openEpoch(grantRef(1).uri);
    return yield* checkAccess({
      space: SPACE,
      did,
      action: 'view',
      collection: RUNS,
      now: NOW,
    });
  });

describe('HostStorage: grants, members, lenses', () => {
  it('ingests a grant and lets the evaluator read it from host storage', async () => {
    const decision = await run(
      Effect.gen(function* () {
        yield* ingestGrant({
          ref: grantRef(1),
          record: record(),
          epoch: 1,
          authority: AUTHORITY,
        });
        return yield* access();
      }).pipe(Effect.provide(layers)),
    );
    expect(Decision.$is('Allow')(decision)).toBe(true);
  });

  it('fails closed when the grant was not issued by the space authority', async () => {
    const error = await run(
      ingestGrant({
        ref: grantRef(1),
        record: record({ issuedBy: BOB }),
        epoch: 1,
        authority: AUTHORITY,
      }).pipe(Effect.flip, Effect.provide(layers)),
    );
    expect(error).toBeInstanceOf(GrantIngestError);
    expect(error.reason).toBe('not-authority');
  });

  it('refuses a stored record with an unmodelled field', async () => {
    const error = await run(
      ingestGrant({
        ref: grantRef(1),
        record: record({ deny: true }),
        epoch: 1,
        authority: AUTHORITY,
      }).pipe(Effect.flip, Effect.provide(layers)),
    );
    expect(error.reason).toBe('decode');
  });

  it('expands a member into roles through host storage', async () => {
    const decision = await run(
      Effect.gen(function* () {
        const host = yield* HostStorage;
        yield* host.putMember(member(ALICE, [ROLE]));
        yield* ingestGrant({
          ref: grantRef(1),
          record: record({ subject: ROLE }),
          epoch: 1,
          authority: AUTHORITY,
        });
        return yield* access();
      }).pipe(Effect.provide(layers)),
    );
    expect(Decision.$is('Allow')(decision)).toBe(true);
  });

  it('denies a lens grant when the pinned lens is incompatible', async () => {
    const decision = await run(
      Effect.gen(function* () {
        const host = yield* HostStorage;
        yield* host.registerLens(LENS, { cid: PINNED, fields: ['a', 'b'] });
        yield* host.registerLens(LENS, { cid: CURRENT, fields: ['a'] });
        yield* ingestGrant({
          ref: grantRef(1),
          record: record({ lens: { nsid: LENS, cid: PINNED } }),
          epoch: 1,
          authority: AUTHORITY,
        });
        return yield* access();
      }).pipe(Effect.provide(layers)),
    );
    expect(decision).toEqual(Decision.Deny({ reason: 'lens-incompatible' }));
  });
});

describe('lens evolution', () => {
  const versions = [
    { cid: PINNED, fields: ['a', 'b'] },
    { cid: CURRENT, fields: ['a', 'b', 'c'] },
  ];
  const lens = { nsid: LENS, cid: PINNED };

  it('is compatible when the newer version only adds fields', () => {
    expect(lensStatusOf(versions, lens)).toBe('compatible');
  });

  it('is compatible when the pinned lens is current', () => {
    expect(lensStatusOf(versions, { nsid: LENS, cid: CURRENT })).toBe(
      'compatible',
    );
  });

  it('is incompatible when a field was removed', () => {
    expect(
      lensStatusOf(
        [
          { cid: PINNED, fields: ['a', 'b'] },
          { cid: CURRENT, fields: ['a'] },
        ],
        lens,
      ),
    ).toBe('incompatible');
  });

  it('is missing when the pinned cid is unknown', () => {
    expect(
      lensStatusOf(versions, { nsid: LENS, cid: cid('bafyunknown') }),
    ).toBe('missing');
  });
});
