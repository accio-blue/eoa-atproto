import {
  AccountStore,
  accountStoreLayer,
  createAlreadyExists,
  createHandleTaken,
} from './account-store.js';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { kvMemoryLayer } from '@eoa/kv';

/**
 * The store's rules are `account-lifecycle.qnt`'s, so this is the spec's
 * boundary cases run against the implementation: a taken handle refuses, a
 * deleted account is terminal, and deleting a live account releases its handle.
 */

const withStore = <A, E>(
  use: (store: AccountStore['Service']) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AccountStore;
      return yield* use(store);
    }).pipe(
      Effect.provide(accountStoreLayer.pipe(Layer.provide(kvMemoryLayer))),
    ),
  );

const createParams = (did: string, handle: string) => ({
  did,
  handle,
  email: null,
  passwordHash: 'pbkdf2$1$salt$hash',
  inviteCode: undefined,
  inviteRequired: false,
  now: 1000,
});

describe('the account store', () => {
  it('registers an account only when the handle is free', async () => {
    const report = await withStore((store) =>
      Effect.gen(function* () {
        const first = yield* store.create(
          createParams('did:web:one', 'alice.pds.example'),
        );
        const taken = yield* store.create(
          createParams('did:web:two', 'alice.pds.example'),
        );
        const holder = yield* store.byHandle('alice.pds.example');
        const stranger = yield* store.account('did:web:two');
        return { first, taken, holder, stranger };
      }),
    );

    expect(report.first._tag).toBe('created');
    // A taken handle refuses — and leaves the second account absent, not
    // half-created.
    expect(report.taken).toEqual(
      createHandleTaken({ handle: 'alice.pds.example' }),
    );
    expect(Option.isSome(report.holder)).toBe(true);
    expect(Option.isNone(report.stranger)).toBe(true);
  });

  it('moves between states only along the spec’s transitions', async () => {
    const report = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(createParams('did:web:one', 'alice.pds.example'));
        const created = yield* store.account('did:web:one');
        // suspend is from active only, so a merely-created account is unmoved.
        const earlySuspend = yield* store.suspend('did:web:one');
        const active = yield* store.activate('did:web:one');
        const suspended = yield* store.suspend('did:web:one');
        // activate is from created only, so a suspended account is unmoved.
        const earlyActivate = yield* store.activate('did:web:one');
        const reinstated = yield* store.reinstate('did:web:one');
        return {
          created,
          earlySuspend,
          active,
          suspended,
          earlyActivate,
          reinstated,
        };
      }),
    );

    expect(Option.getOrThrow(report.created).status).toBe('created');
    expect(Option.getOrThrow(report.earlySuspend).status).toBe('created');
    expect(Option.getOrThrow(report.active).status).toBe('active');
    expect(Option.getOrThrow(report.suspended).status).toBe('suspended');
    expect(Option.getOrThrow(report.earlyActivate).status).toBe('suspended');
    expect(Option.getOrThrow(report.reinstated).status).toBe('active');
  });

  it('releases the handle on deletion, and a deleted account is terminal', async () => {
    const report = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(createParams('did:web:one', 'alice.pds.example'));
        yield* store.activate('did:web:one');
        const removed = yield* store.remove('did:web:one');
        const held = yield* store.byHandle('alice.pds.example');
        // The row stays, so the same DID can never be created again...
        const again = yield* store.create(
          createParams('did:web:one', 'alice.pds.example'),
        );
        // ...while the handle itself is free for a *new* account.
        const second = yield* store.create(
          createParams('did:web:two', 'alice.pds.example'),
        );
        const holder = yield* store.byHandle('alice.pds.example');
        return { removed, held, again, second, holder };
      }),
    );

    expect(Option.getOrThrow(report.removed).status).toBe('deleted');
    expect(Option.isNone(report.held)).toBe(true);
    expect(report.again).toEqual(createAlreadyExists({ did: 'did:web:one' }));
    expect(report.second._tag).toBe('created');
    expect(Option.getOrThrow(report.holder).did).toBe('did:web:two');
  });

  it('does not delete an account that was never activated', async () => {
    const report = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(createParams('did:web:one', 'alice.pds.example'));
        const removed = yield* store.remove('did:web:one');
        const held = yield* store.byHandle('alice.pds.example');
        return { removed, held };
      }),
    );

    expect(Option.getOrThrow(report.removed).status).toBe('created');
    expect(Option.isSome(report.held)).toBe(true);
  });

  it('spends an invite once, and only on an account it is for', async () => {
    const report = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.putInvite({
          code: 'aaaaa-bbbbb-ccccc-ddddd-eeeee',
          forAccount: null,
          createdBy: 'did:web:one',
          createdAt: 1,
          usesAvailable: 1,
          disabled: false,
        });
        const needed = yield* store.create({
          ...createParams('did:web:two', 'bob.pds.example'),
          inviteRequired: true,
        });
        const bad = yield* store.create({
          ...createParams('did:web:three', 'carol.pds.example'),
          inviteCode: 'zzzzz-zzzzz-zzzzz-zzzzz-zzzzz',
        });
        const used = yield* store.create({
          ...createParams('did:web:two', 'bob.pds.example'),
          inviteCode: 'aaaaa-bbbbb-ccccc-ddddd-eeeee',
        });
        // The one use is gone, so the next account cannot spend it.
        const spent = yield* store.create({
          ...createParams('did:web:three', 'carol.pds.example'),
          inviteCode: 'aaaaa-bbbbb-ccccc-ddddd-eeeee',
        });
        const invite = yield* store.invite('aaaaa-bbbbb-ccccc-ddddd-eeeee');
        return { needed, bad, used, spent, invite };
      }),
    );

    expect(report.needed._tag).toBe('inviteRequired');
    expect(report.bad._tag).toBe('inviteInvalid');
    expect(report.used._tag).toBe('created');
    expect(report.spent._tag).toBe('inviteInvalid');
    expect(Option.getOrThrow(report.invite).usesAvailable).toBe(0);
  });

  it('admits one DID, until the instant the ticket names, and one revoke leaves the rest', async () => {
    const bound = 'aaaaa-bbbbb-ccccc-ddddd-eeeee';
    const revoked = 'fffff-ggggg-hhhhh-iiiii-jjjjj';
    const report = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.putInvite({
          code: bound,
          forAccount: 'did:web:two',
          createdBy: 'did:web:one',
          createdAt: 1000,
          expiresAt: 2000,
          usesAvailable: 1,
          disabled: false,
        });
        yield* store.putInvite({
          code: revoked,
          forAccount: null,
          createdBy: 'did:web:one',
          createdAt: 1000,
          usesAvailable: 1,
          disabled: true,
        });
        // A ticket names one DID: another one presenting it is not admitted.
        const other = yield* store.create({
          ...createParams('did:web:three', 'carol.pds.example'),
          inviteCode: bound,
          now: 1500,
        });
        // At the instant it named, it is over — not after it.
        const late = yield* store.create({
          ...createParams('did:web:two', 'bob.pds.example'),
          inviteCode: bound,
          now: 2000,
        });
        // A revoked ticket is refused even with a use left.
        const disabled = yield* store.create({
          ...createParams('did:web:four', 'dan.pds.example'),
          inviteCode: revoked,
          now: 1500,
        });
        // And the DID it was for, before the end, gets in.
        const inTime = yield* store.create({
          ...createParams('did:web:two', 'bob.pds.example'),
          inviteCode: bound,
          now: 1500,
        });
        return { other, late, disabled, inTime };
      }),
    );

    expect(report.other._tag).toBe('inviteInvalid');
    expect(report.late._tag).toBe('inviteInvalid');
    expect(report.disabled._tag).toBe('inviteInvalid');
    expect(report.inTime._tag).toBe('created');
  });

  it('keeps sessions and app passwords per account', async () => {
    const report = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(createParams('did:web:one', 'alice.pds.example'));
        yield* store.putSession({
          id: 's1',
          did: 'did:web:one',
          appPasswordName: null,
          createdAt: 1,
          expiresAt: 2,
        });
        yield* store.putAppPassword('did:web:one', {
          name: 'robot',
          digest: 'digest',
          privileged: false,
          createdAt: 1,
        });
        const sessions = yield* store.sessions('did:web:one');
        const found = yield* store.session('did:web:one', 's1');
        const missing = yield* store.session('did:web:one', 's2');
        const passwords = yield* store.appPasswords('did:web:one');
        // Deleting the account takes its sessions with it.
        yield* store.activate('did:web:one');
        yield* store.remove('did:web:one');
        const after = yield* store.sessions('did:web:one');
        return { sessions, found, missing, passwords, after };
      }),
    );

    expect(report.sessions.map((one) => one.id)).toEqual(['s1']);
    expect(Option.getOrThrow(report.found).did).toBe('did:web:one');
    expect(Option.isNone(report.missing)).toBe(true);
    expect(report.passwords.map((one) => one.name)).toEqual(['robot']);
    expect(report.after).toEqual([]);
  });
});
