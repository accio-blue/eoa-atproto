import {
  ALICE,
  AUTHORITY,
  BOB,
  NOTES,
  NOW,
  ROLE,
  RUNS,
  SPACE,
  aturi,
  cid,
  did,
  grantRef,
  nsid,
  stored,
  utc,
} from './fixtures.js';
import {
  type AccessRequest,
  type CheckAccessOptions,
  Decision,
  type DenyReason,
  GrantStore,
  LensRegistry,
  Membership,
  type StoredGrant,
  checkAccess,
  makeDecisionCache,
} from './evaluate.js';
import { DateTime, Effect, Fiber, Layer, Result } from 'effect';
import { Grant, LookupError, decodeGrant, mayReadGrant } from './grant.js';
import { describe, expect, it } from 'vitest';
import { RevocationLog } from './revocation.js';
import { TestClock } from 'effect/testing';

const request = (overrides: Partial<AccessRequest> = {}): AccessRequest => ({
  space: SPACE,
  did: ALICE,
  action: 'view',
  collection: RUNS,
  now: NOW,
  ...overrides,
});

interface Setup {
  readonly lenses?: ReadonlyMap<
    ReturnType<typeof nsid>,
    ReturnType<typeof cid>
  >;
  /** What a compatible lens projects, when a test wants the shared shape to matter. */
  readonly projection?: { readonly fields: ReadonlyArray<string> };
  readonly membership?: Layer.Layer<Membership>;
  /** Runs after every grant opened its epoch, before the check. */
  readonly beforeCheck?: Effect.Effect<void, LookupError, RevocationLog>;
  readonly options?: CheckAccessOptions;
}

/** Issue every grant (opens its epoch), run `beforeCheck`, then `checkAccess`. */
const check = (
  grants: ReadonlyArray<StoredGrant>,
  req: AccessRequest,
  setup: Setup = {},
) =>
  Effect.gen(function* () {
    const log = yield* RevocationLog;
    for (const entry of grants) {
      for (let epoch = 0; epoch < entry.epoch; epoch += 1) {
        yield* log.openEpoch(entry.ref.uri);
      }
    }
    if (setup.beforeCheck !== undefined) {
      yield* setup.beforeCheck;
    }
    return yield* checkAccess(req, setup.options);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GrantStore.layerInMemory(grants),
        setup.membership ?? Membership.layerNone,
        RevocationLog.layerInMemory,
        LensRegistry.layerFromCurrent(
          setup.lenses ?? new Map(),
          setup.projection,
        ),
      ),
    ),
    Effect.runPromise,
  );

const denied = (reason: DenyReason) => Decision.Deny({ reason });
const isAllow = Decision.$is('Allow');

describe('checkAccess: default deny', () => {
  it('denies when there is no grant at all', async () => {
    expect(await check([], request())).toEqual(denied('no-grant'));
  });

  it('allows a matching grant and names it', async () => {
    expect(await check([stored()], request())).toEqual(
      Decision.Allow({ grant: grantRef(1) }),
    );
  });

  it('denies a grant for another space', async () => {
    const other = aturi('at://did:plc:authority/ing.lexicon.space/other');
    expect(await check([stored({ space: other })], request())).toEqual(
      denied('no-grant'),
    );
  });

  it('denies a grant addressed to someone else', async () => {
    expect(await check([stored({ subject: BOB })], request())).toEqual(
      denied('no-grant'),
    );
  });

  it('denies an action the grant does not carry', async () => {
    expect(await check([stored()], request({ action: 'write' }))).toEqual(
      denied('no-grant'),
    );
    const writer = stored({ actions: ['write'] });
    expect(isAllow(await check([writer], request({ action: 'write' })))).toBe(
      true,
    );
  });

  it('denies a space-level request with no collection or record', async () => {
    const { collection: _omitted, ...bare } = request();
    expect(await check([stored()], bare)).toEqual(denied('no-grant'));
  });
});

describe('checkAccess: positive-only', () => {
  it('has no deny rule: an unrelated grant never turns an allow into a deny', async () => {
    const mine = stored();
    const unrelated = stored(
      { subject: BOB, selectors: [{ collection: NOTES }] },
      { n: 2 },
    );
    const alone = await check([mine], request());
    const together = await check([mine, unrelated], request());
    expect(isAllow(alone)).toBe(true);
    expect(together).toEqual(alone);
  });

  it('refuses a grant that tries to carry a deny field', async () => {
    const wire = {
      space: SPACE,
      subject: ALICE,
      selectors: [{ collection: RUNS }],
      actions: ['view'],
      issuedBy: AUTHORITY,
      createdAt: '2026-01-01T00:00:00Z',
      deny: [{ collection: NOTES }],
    };
    const result = await Effect.runPromise(
      decodeGrant(wire).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(Object.keys(Grant.fields)).not.toContain('deny');
  });

  it('decodes a full grant from its wire form', async () => {
    const grant = await Effect.runPromise(
      decodeGrant({
        space: SPACE,
        subject: ALICE,
        selectors: [{ collection: RUNS }, { record: grantRef(9) }],
        actions: ['view', 'write'],
        lens: { nsid: 'ing.lexicon.lens', cid: 'bafylens' },
        expiry: '2027-01-01T00:00:00Z',
        retention: { materialize: 'forbidden', maxAge: 60 },
        purpose: 'training',
        consent: 'at://did:plc:alice/ing.lexicon.consent/c1',
        issuedBy: AUTHORITY,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    );
    expect(grant.selectors).toHaveLength(2);
    expect(grant.expiry).toEqual(utc('2027-01-01T00:00:00Z'));
  });

  it('refuses empty actions, unknown actions and mixed selectors', async () => {
    const base = {
      space: SPACE,
      subject: ALICE,
      issuedBy: AUTHORITY,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const bad = [
      { ...base, selectors: [{ collection: RUNS }], actions: [] },
      { ...base, selectors: [{ collection: RUNS }], actions: ['admin'] },
      { ...base, selectors: [], actions: ['view'] },
      {
        ...base,
        selectors: [{ collection: RUNS, record: grantRef(1) }],
        actions: ['view'],
      },
    ];
    for (const wire of bad) {
      const result = await Effect.runPromise(
        decodeGrant(wire).pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
    }
  });
});

describe('checkAccess: scope', () => {
  it('a collection grant covers every record in the collection', async () => {
    const grant = stored({ selectors: [{ collection: RUNS }] });
    const req = request({
      record: aturi('at://did:plc:alice/ing.lexicon.run/any'),
    });
    expect(isAllow(await check([grant], req))).toBe(true);
    expect(await check([grant], request({ collection: NOTES }))).toEqual(
      denied('no-grant'),
    );
  });

  it('a record grant covers that exact record only', async () => {
    const target = aturi('at://did:plc:alice/ing.lexicon.run/one');
    const grant = stored({
      selectors: [{ record: { uri: target, cid: cid('bafyrec') } }],
    });
    expect(isAllow(await check([grant], request({ record: target })))).toBe(
      true,
    );
    const sibling = aturi('at://did:plc:alice/ing.lexicon.run/two');
    expect(await check([grant], request({ record: sibling }))).toEqual(
      denied('no-grant'),
    );
    expect(await check([grant], request())).toEqual(denied('no-grant'));
  });
});

describe('checkAccess: a selector that names fields promises a projection', () => {
  const withFields = (fields: readonly [string, ...Array<string>]) =>
    stored({ selectors: [{ collection: RUNS, fields }] });

  it('covers a read and carries the projection the server has to apply', async () => {
    expect(
      await check([withFields(['/startedAt', '/note'])], request()),
    ).toEqual(
      Decision.Allow({
        grant: grantRef(1),
        fields: ['/startedAt', '/note'],
      }),
    );
  });

  it('covers a write that names only promised fields', async () => {
    const writer = stored({
      selectors: [{ collection: RUNS, fields: ['/startedAt'] }],
      actions: ['write'],
    });
    expect(
      isAllow(
        await check(
          [writer],
          request({ action: 'write', fields: ['/startedAt'] }),
        ),
      ),
    ).toBe(true);
  });

  it('denies a write of a field the grant did not promise', async () => {
    const writer = stored({
      selectors: [{ collection: RUNS, fields: ['/startedAt'] }],
      actions: ['write'],
    });
    expect(
      await check([writer], request({ action: 'write', fields: ['/note'] })),
    ).toEqual(denied('no-grant'));
  });

  it('denies a write that names no fields, so a projection cannot be widened', async () => {
    const writer = stored({
      selectors: [{ collection: RUNS, fields: ['/startedAt'] }],
      actions: ['write'],
    });
    expect(await check([writer], request({ action: 'write' }))).toEqual(
      denied('no-grant'),
    );
    expect(
      await check(
        [writer],
        request({ action: 'write', fields: ['/startedAt', '/note'] }),
      ),
    ).toEqual(denied('no-grant'));
  });

  it('carries the condition the winning selector put on the record', async () => {
    const conditioned = stored({
      selectors: [
        {
          collection: RUNS,
          condition: { field: '/createdAt', maxAgeSeconds: 3600 },
        },
      ],
    });
    expect(await check([conditioned], request())).toEqual(
      Decision.Allow({
        grant: grantRef(1),
        condition: { field: '/createdAt', maxAgeSeconds: 3600 },
      }),
    );
  });

  it('does not cover a write when the selector carries a condition', async () => {
    const conditioned = stored({
      selectors: [
        {
          collection: RUNS,
          condition: { field: '/createdAt', maxAgeSeconds: 3600 },
        },
      ],
      actions: ['write'],
    });
    // The evaluator holds no record, so it cannot say the condition passed: silence there would
    // mean "yes", which is the one answer it must never guess.
    expect(await check([conditioned], request({ action: 'write' }))).toEqual(
      denied('no-grant'),
    );
  });

  it('leaves a selector without fields covering the whole record', async () => {
    expect(await check([stored()], request())).toEqual(
      Decision.Allow({ grant: grantRef(1) }),
    );
  });
});

describe('checkAccess: expiry', () => {
  const grant = stored({ expiry: utc('2026-10-04T13:00:00Z') });

  it('allows before expiry', async () => {
    expect(isAllow(await check([grant], request()))).toBe(true);
  });

  it('denies at and after expiry', async () => {
    const atExpiry = request({ now: utc('2026-10-04T13:00:00Z') });
    expect(await check([grant], atExpiry)).toEqual(denied('expired'));
    const later = request({ now: utc('2027-01-01T00:00:00Z') });
    expect(await check([grant], later)).toEqual(denied('expired'));
  });

  it('reads the Clock when no `now` is given', async () => {
    const { now: _omitted, ...clocked } = request();
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(utc('2026-10-04T12:30:00Z')),
      );
      const before = yield* checkAccess(clocked);
      yield* TestClock.setTime(
        DateTime.toEpochMillis(utc('2026-10-04T13:30:00Z')),
      );
      const after = yield* checkAccess(clocked);
      return [before, after] as const;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          GrantStore.layerInMemory([grant]),
          Membership.layerNone,
          RevocationLog.layerInMemory,
          LensRegistry.layerFromCurrent(new Map()),
          TestClock.layer(),
        ),
      ),
    );
    const [before, after] = await Effect.runPromise(program);
    expect(isAllow(before)).toBe(true);
    expect(after).toEqual(denied('expired'));
  });
});

describe('checkAccess: revocation epochs', () => {
  const revokeEpoch = (n: number, epoch: number) =>
    Effect.gen(function* () {
      const log = yield* RevocationLog;
      yield* log.append(grantRef(n).uri, epoch);
    });

  it('denies once the epoch is revoked', async () => {
    const result = await check([stored()], request(), {
      beforeCheck: revokeEpoch(1, 1),
    });
    expect(result).toEqual(denied('revoked'));
  });

  it('a re-grant opens a new epoch the old revocation does not cover', async () => {
    // issued twice: epoch 2 is the live grant, epoch 1 was revoked
    const regrant = stored({}, { epoch: 2 });
    const result = await check([regrant], request(), {
      beforeCheck: revokeEpoch(1, 1),
    });
    expect(isAllow(result)).toBe(true);
  });

  it('a stale revoke record cannot un-revoke or revoke the wrong epoch', async () => {
    const regrant = stored({}, { epoch: 2 });
    const revoked = await check([regrant], request(), {
      beforeCheck: revokeEpoch(1, 1).pipe(
        Effect.andThen(revokeEpoch(1, 2)),
        Effect.andThen(revokeEpoch(1, 1)),
      ),
    });
    expect(revoked).toEqual(denied('revoked'));
  });

  it('a revoke naming a future epoch is ignored', async () => {
    const result = await check([stored()], request(), {
      beforeCheck: revokeEpoch(1, 5),
    });
    expect(isAllow(result)).toBe(true);
  });

  it('another live grant still allows when one is revoked', async () => {
    const revoked = stored({}, { n: 1 });
    const live = stored({}, { n: 2 });
    const result = await check([revoked, live], request(), {
      beforeCheck: revokeEpoch(1, 1),
    });
    expect(result).toEqual(Decision.Allow({ grant: grantRef(2) }));
  });
});

describe('checkAccess: lens binding fails closed', () => {
  const lens = { nsid: nsid('ing.lexicon.lens'), cid: cid('bafylens') };
  const pinned = stored({ lens });

  it('allows when the pinned lens is current', async () => {
    const lenses = new Map([[lens.nsid, lens.cid]]);
    expect(isAllow(await check([pinned], request(), { lenses }))).toBe(true);
  });

  it('denies when the lens is missing', async () => {
    expect(await check([pinned], request())).toEqual(denied('lens-missing'));
  });

  it('denies when the lens changed incompatibly', async () => {
    const lenses = new Map([[lens.nsid, cid('bafynewlens')]]);
    expect(await check([pinned], request(), { lenses })).toEqual(
      denied('lens-incompatible'),
    );
  });

  it('denies a request for a different lens than the grant pins', async () => {
    const lenses = new Map([[lens.nsid, lens.cid]]);
    const other = { nsid: lens.nsid, cid: cid('bafyother') };
    expect(await check([pinned], request({ lens: other }), { lenses })).toEqual(
      denied('lens-mismatch'),
    );
  });

  it('a grant without a lens does not depend on the registry', async () => {
    expect(isAllow(await check([stored()], request({ lens })))).toBe(true);
  });

  it('carries the shared projection of a compatible lens', async () => {
    const lenses = new Map([[lens.nsid, lens.cid]]);
    expect(
      await check([pinned], request(), {
        lenses,
        projection: { fields: ['/startedAt'] },
      }),
    ).toEqual(Decision.Allow({ grant: grantRef(1), fields: ['/startedAt'] }));
  });

  it('refuses a grant that would project more than its lens', async () => {
    const lenses = new Map([[lens.nsid, lens.cid]]);
    const wider = stored({
      lens,
      selectors: [{ collection: RUNS, fields: ['/startedAt', '/secret'] }],
    });
    expect(
      await check([wider], request(), {
        lenses,
        projection: { fields: ['/startedAt'] },
      }),
    ).toEqual(denied('lens-mismatch'));
  });

  it('lets a grant narrow its lens', async () => {
    const lenses = new Map([[lens.nsid, lens.cid]]);
    const narrower = stored({
      lens,
      selectors: [{ collection: RUNS, fields: ['/startedAt'] }],
    });
    expect(
      await check([narrower], request(), {
        lenses,
        projection: { fields: ['/startedAt', '/note'] },
      }),
    ).toEqual(Decision.Allow({ grant: grantRef(1), fields: ['/startedAt'] }));
  });
});

describe('checkAccess: membership expansion', () => {
  const roleGrant = stored({ subject: ROLE });
  const members = Membership.layerFrom((_space, who) =>
    who === ALICE ? [ROLE] : [],
  );

  it('a member inherits a grant addressed to the role DID', async () => {
    expect(
      isAllow(await check([roleGrant], request(), { membership: members })),
    ).toBe(true);
  });

  it('a non-member does not, and without a lookup nobody does', async () => {
    expect(
      await check([roleGrant], request({ did: BOB }), { membership: members }),
    ).toEqual(denied('no-grant'));
    expect(await check([roleGrant], request())).toEqual(denied('no-grant'));
  });

  it('a failing membership lookup denies', async () => {
    const broken = Layer.succeed(
      Membership,
      Membership.of({
        expand: () =>
          Effect.fail(
            new LookupError({ source: 'membership', message: 'unavailable' }),
          ),
      }),
    );
    expect(await check([roleGrant], request(), { membership: broken })).toEqual(
      denied('lookup-failed'),
    );
  });
});

describe('checkAccess: bounded timeout + cache seam', () => {
  const hangingStore = Layer.succeed(
    GrantStore,
    GrantStore.of({ grantsFor: () => Effect.never }),
  );
  const rest = Layer.mergeAll(
    Membership.layerNone,
    RevocationLog.layerInMemory,
    LensRegistry.layerFromCurrent(new Map()),
  );

  it('denies with `timeout` when a lookup hangs', async () => {
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        checkAccess(request(), { timeout: '1 second' }),
      );
      yield* TestClock.adjust('1 second');
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(Layer.mergeAll(hangingStore, rest, TestClock.layer())),
    );
    expect(await Effect.runPromise(program)).toEqual(denied('timeout'));
  });

  it('caches definitive answers but not transient ones', async () => {
    let calls = 0;
    const counting = Layer.succeed(
      GrantStore,
      GrantStore.of({
        grantsFor: () =>
          Effect.suspend(() => {
            calls += 1;
            return calls === 1
              ? Effect.fail(
                  new LookupError({ source: 'grant-store', message: 'blip' }),
                )
              : Effect.succeed([stored()]);
          }),
      }),
    );
    const { now: _omitted, ...clocked } = request();
    const program = Effect.gen(function* () {
      const cache = yield* makeDecisionCache('1 minute');
      const options = { cache };
      const first = yield* checkAccess(clocked, options);
      const second = yield* checkAccess(clocked, options);
      const third = yield* checkAccess(clocked, options);
      return [first, second, third] as const;
    }).pipe(Effect.provide(Layer.mergeAll(counting, rest)));
    const [first, second, third] = await Effect.runPromise(program);
    expect(first).toEqual(denied('lookup-failed'));
    expect(isAllow(second)).toBe(true);
    expect(third).toEqual(second);
    expect(calls).toBe(2);
  });
});

describe('grant self-read', () => {
  const grant = stored({ subject: ALICE, issuedBy: AUTHORITY }).grant;

  it('the subject and the issuer may read the grant; nobody else', () => {
    expect(mayReadGrant(ALICE, grant)).toBe(true);
    expect(mayReadGrant(AUTHORITY, grant)).toBe(true);
    expect(mayReadGrant(BOB, grant)).toBe(false);
    expect(mayReadGrant(did('did:plc:members'), grant)).toBe(false);
  });

  it('needs no grant: a view-less subject can still read their own grant', () => {
    expect(mayReadGrant(ALICE, stored({ actions: ['write'] }).grant)).toBe(
      true,
    );
  });
});
