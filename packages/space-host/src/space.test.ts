import {
  ALICE,
  AUTHORITY,
  BOB,
  NOW,
  RECOVERY,
  ROLE,
  RUNS,
  SPACE,
  SPACE_KEY,
  SPACE_TYPE,
  aturi,
  authority,
  member,
  stored,
} from './fixtures.js';
import { Decision, GrantStore, LensRegistry, checkAccess } from './evaluate.js';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  isAdmin,
  isAuthority,
  isRecovery,
  layerMembershipFrom,
  mayConfigure,
  recoveryIsDistinct,
  rolesOf,
  spaceFromUri,
  spaceUriOf,
} from './space.js';
import { RevocationLog } from './revocation.js';

describe('space address', () => {
  it('maps (authority, type, skey) to at://authority/type/skey and back', () => {
    const space = { authority: AUTHORITY, type: SPACE_TYPE, skey: SPACE_KEY };
    expect(spaceUriOf(space)).toBe(SPACE);
    expect(spaceFromUri(SPACE)).toEqual(space);
  });

  it('refuses an at-uri that is not a three-part space address', () => {
    expect(
      spaceFromUri(aturi('at://did:plc:authority/ing.lexicon.space')),
    ).toBe(undefined);
    expect(
      spaceFromUri(
        aturi('at://did:plc:authority/ing.lexicon.space/club/extra'),
      ),
    ).toBe(undefined);
  });

  it('refuses a part that is not a valid authority, type or skey', () => {
    expect(spaceFromUri(aturi('at://did:plc:authority/bad_nsid/club'))).toBe(
      undefined,
    );
  });
});

describe('space authority: two-tier administration', () => {
  it('names the owning authority and the day-to-day admins', () => {
    const config = authority({ admins: [BOB] });
    expect(isAuthority(config, AUTHORITY)).toBe(true);
    expect(isAuthority(config, BOB)).toBe(false);
    expect(isAdmin(config, BOB)).toBe(true);
    expect(isAdmin(config, ALICE)).toBe(false);
    expect(isRecovery(config, RECOVERY)).toBe(true);
  });

  it('lets the authority, an admin and recovery configure; nobody else', () => {
    const config = authority({ admins: [BOB] });
    expect(mayConfigure(config, AUTHORITY)).toBe(true);
    expect(mayConfigure(config, BOB)).toBe(true);
    expect(mayConfigure(config, RECOVERY)).toBe(true);
    expect(mayConfigure(config, ALICE)).toBe(false);
  });

  it('keeps the recovery root distinct from the authority and the admins', () => {
    expect(recoveryIsDistinct(authority())).toBe(true);
    expect(recoveryIsDistinct(authority({ recovery: AUTHORITY }))).toBe(false);
    expect(recoveryIsDistinct(authority({ admins: [RECOVERY] }))).toBe(false);
  });
});

describe('membership: roles are lookups', () => {
  it('returns the role DIDs a member stands for, deduplicated', () => {
    const entries = [member(ALICE, [ROLE]), member(ALICE, [ROLE])];
    expect(rolesOf(entries, SPACE, ALICE)).toEqual([ROLE]);
  });

  it('has no roles for a non-member or another space', () => {
    const entries = [member(ALICE, [ROLE])];
    expect(rolesOf(entries, SPACE, BOB)).toEqual([]);
    expect(
      rolesOf(
        [
          member(ALICE, [ROLE], {
            space: aturi('at://did:plc:authority/ing.lexicon.space/other'),
          }),
        ],
        SPACE,
        ALICE,
      ),
    ).toEqual([]);
  });

  /** A grant addressed to a role DID, checked for a member whose list names that role. */
  const check = (
    grants: ReadonlyArray<ReturnType<typeof stored>>,
    membership: Layer.Layer<import('./evaluate.js').Membership>,
  ) =>
    Effect.gen(function* () {
      const log = yield* RevocationLog;
      for (const entry of grants) {
        for (let epoch = 0; epoch < entry.epoch; epoch += 1) {
          yield* log.openEpoch(entry.ref.uri);
        }
      }
      return yield* checkAccess({
        space: SPACE,
        did: ALICE,
        action: 'view',
        collection: RUNS,
        now: NOW,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          GrantStore.layerInMemory(grants),
          membership,
          RevocationLog.layerInMemory,
          LensRegistry.layerFromCurrent(new Map()),
        ),
      ),
      Effect.runPromise,
    );

  it('lets a member through a grant addressed to their role', async () => {
    const grant = stored({ subject: ROLE });
    const decision = await check(
      [grant],
      layerMembershipFrom([member(ALICE, [ROLE])]),
    );
    expect(Decision.$is('Allow')(decision)).toBe(true);
  });

  it('denies a role grant to someone the list does not place in the role', async () => {
    const grant = stored({ subject: ROLE });
    const decision = await check(
      [grant],
      layerMembershipFrom([member(BOB, [ROLE])]),
    );
    expect(decision).toEqual(Decision.Deny({ reason: 'no-grant' }));
  });
});
