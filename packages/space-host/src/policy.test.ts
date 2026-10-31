import { ALICE, AUTHORITY, BOB, nsid } from './fixtures.js';
import { Effect, Result } from 'effect';
import {
  MANAGED_POLICY_TYPE,
  MEMBER_POLICY_TYPE,
  MEMBER_RECORD_COLLECTION,
  type MemberPolicy,
  PERSONAL_POLICY_TYPE,
  POLICY_RECORD_COLLECTION,
  type Policy,
  PolicyVerdict,
  SPACE_METHODS,
  decideRead,
  decideSessionRead,
  decideWrite,
  decodePolicy,
  isPolicyRecordCollection,
  memberRecordsOf,
  policyRecordOf,
  policyStateSurvives,
  publicReadOf,
  publicWriteOf,
} from './policy.js';
import { describe, expect, it } from 'vitest';
import { type DID } from '@eoa/core';

/**
 * The three baseline policies of the 2026-10-29 alpha (proposal#119,
 * atproto#5764). What is fixed by the spec is asserted here; what it leaves open
 * is listed at the bottom rather than guessed at.
 */

const personal: Policy = { $type: PERSONAL_POLICY_TYPE };

const member = (fields: Partial<Omit<MemberPolicy, '$type'>> = {}): Policy => ({
  $type: MEMBER_POLICY_TYPE,
  ...fields,
});

const managed: Policy = {
  $type: MANAGED_POLICY_TYPE,
  managingApp: 'did:web:forum.example#forum',
};

const reader = { read: true, write: false };
const writer = { read: false, write: true };

const read = (
  policy: Policy,
  did: DID,
  access: typeof reader | undefined,
  app: string | undefined = undefined,
) =>
  decideRead({
    policy,
    did,
    authority: AUTHORITY,
    member: access,
    app,
  });

const write = (policy: Policy, did: DID, access: typeof reader | undefined) =>
  decideWrite({ policy, did, authority: AUTHORITY, member: access });

describe('policy decoding: lexicon defaults', () => {
  it('reads absent flags as false and an absent allowedApps as any app', async () => {
    const policy = await Effect.runPromise(
      decodePolicy({ $type: MEMBER_POLICY_TYPE }),
    );
    expect(publicReadOf(policy)).toBe(false);
    expect(publicWriteOf(policy)).toBe(false);
    expect(
      policy.$type === MEMBER_POLICY_TYPE ? policy.allowedApps : 'personal',
    ).toBe(undefined);
  });

  it('refuses a policy type the host does not implement', async () => {
    const result = await Effect.runPromise(
      decodePolicy({ $type: 'app.bsky.unknownspace.policy' }).pipe(
        Effect.result,
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe('personalspace: the authority alone', () => {
  it('allows the authority and refuses everyone else, read and write', () => {
    expect(read(personal, AUTHORITY, undefined)).toEqual(PolicyVerdict.Allow());
    expect(read(personal, ALICE, reader)).toEqual(
      PolicyVerdict.Deny({ reason: 'only-the-authority' }),
    );
    expect(write(personal, ALICE, writer)).toEqual(
      PolicyVerdict.Deny({ reason: 'only-the-authority' }),
    );
  });
});

describe('memberspace: a member list, read and write independent', () => {
  it('authorizes a member whose entry has the matching boolean', () => {
    expect(read(member(), ALICE, reader)).toEqual(PolicyVerdict.Allow());
    expect(write(member(), ALICE, writer)).toEqual(PolicyVerdict.Allow());
    expect(read(member(), ALICE, { read: false, write: true })).toEqual(
      PolicyVerdict.Deny({ reason: 'member-has-no-read' }),
    );
    expect(write(member(), ALICE, reader)).toEqual(
      PolicyVerdict.Deny({ reason: 'member-has-no-write' }),
    );
  });

  it('refuses someone who is not on the list at all', () => {
    expect(read(member(), BOB, undefined)).toEqual(
      PolicyVerdict.Deny({ reason: 'not-a-member' }),
    );
  });

  it('publicRead opens reading to anyone, but not writing, and still checks the app', () => {
    const policy = member({ publicRead: true });
    expect(read(policy, BOB, undefined)).toEqual(PolicyVerdict.Allow());
    expect(write(policy, BOB, undefined)).toEqual(
      PolicyVerdict.Deny({ reason: 'not-a-member' }),
    );
    const restricted = member({
      publicRead: true,
      allowedApps: ['https://app.example/oauth'],
    });
    expect(read(restricted, BOB, undefined, undefined)).toEqual(
      PolicyVerdict.Deny({ reason: 'app-not-allowed' }),
    );
    expect(
      read(restricted, BOB, undefined, 'https://app.example/oauth'),
    ).toEqual(PolicyVerdict.Allow());
  });

  it('an empty allowedApps is a set with nobody on it, not "any app"', () => {
    expect(read(member({ allowedApps: [] }), ALICE, reader)).toEqual(
      PolicyVerdict.Deny({ reason: 'app-not-allowed' }),
    );
  });

  it('publicWrite tracks anyone, and the authority is always authorized', () => {
    const policy = member({ publicWrite: true });
    expect(write(policy, BOB, undefined)).toEqual(PolicyVerdict.Allow());
    expect(write(policy, AUTHORITY, undefined)).toEqual(PolicyVerdict.Allow());
    expect(read(policy, AUTHORITY, undefined)).toEqual(PolicyVerdict.Allow());
  });
});

describe('managedspace: every decision is deferred', () => {
  it('asks the managing app for both reads and writes, authority excepted', () => {
    expect(read(managed, ALICE, reader)).toEqual(PolicyVerdict.Ask());
    expect(write(managed, ALICE, writer)).toEqual(PolicyVerdict.Ask());
    expect(read(managed, AUTHORITY, undefined)).toEqual(PolicyVerdict.Allow());
  });
});

describe('policy migration and publication', () => {
  it('keeps policy state only when the $type is unchanged', () => {
    expect(policyStateSurvives(member(), member({ publicRead: true }))).toBe(
      true,
    );
    expect(policyStateSurvives(member(), personal)).toBe(false);
    expect(policyStateSurvives(managed, personal)).toBe(false);
  });

  it('publishes nothing by default', () => {
    expect(policyRecordOf(member())).toBe(undefined);
    expect(
      memberRecordsOf({
        policy: member(),
        members: new Map([[ALICE, reader]]),
      }),
    ).toEqual([]);
    expect(policyRecordOf(personal)).toBe(undefined);
  });

  it('publishes the policy at self and each member keyed by DID when asked', () => {
    const policy = member({ publishPolicy: true, publishMembers: true });
    expect(policyRecordOf(policy)).toEqual({
      collection: POLICY_RECORD_COLLECTION,
      rkey: 'self',
      value: { policy },
    });
    expect(
      memberRecordsOf({
        policy,
        members: new Map([
          [ALICE, reader],
          [BOB, writer],
        ]),
      }),
    ).toEqual([
      {
        collection: MEMBER_RECORD_COLLECTION,
        rkey: ALICE,
        value: reader,
      },
      {
        collection: MEMBER_RECORD_COLLECTION,
        rkey: BOB,
        value: writer,
      },
    ]);
  });

  it('reserves the published collections against direct record writes', () => {
    expect(isPolicyRecordCollection(POLICY_RECORD_COLLECTION)).toBe(true);
    expect(isPolicyRecordCollection(MEMBER_RECORD_COLLECTION)).toBe(true);
    expect(isPolicyRecordCollection(nsid('ing.lexicon.run'))).toBe(false);
  });

  it('names the lifecycle methods under com.atproto.space after the split', () => {
    expect(SPACE_METHODS.createSpace).toBe('com.atproto.space.createSpace');
    expect(SPACE_METHODS.putMember).toBe('com.atproto.memberspace.putMember');
    expect(SPACE_METHODS.checkUserAccess).toBe(
      'com.atproto.managedspace.checkUserAccess',
    );
  });
});

describe('decideSessionRead: a person is not an app', () => {
  const session = (
    policy: Policy,
    did: DID,
    access: typeof reader | undefined,
  ) => decideSessionRead({ policy, did, authority: AUTHORITY, member: access });

  it('lets a member read, and refuses one whose read flag is off', () => {
    expect(session(member(), BOB, reader)).toEqual(PolicyVerdict.Allow());
    expect(session(member(), BOB, writer)).toEqual(
      PolicyVerdict.Deny({ reason: 'member-has-no-read' }),
    );
  });

  it('does not ask allowedApps, which is a question about apps', () => {
    // An empty allow-list refuses every *app* (`decideRead`), and says nothing about a person
    // reading with a session — which is the whole reason this function exists.
    const closed = member({ allowedApps: [] });
    expect(session(closed, BOB, reader)).toEqual(PolicyVerdict.Allow());
    expect(read(closed, BOB, reader)).toEqual(
      PolicyVerdict.Deny({ reason: 'app-not-allowed' }),
    );
  });

  it('is the authority, public read, or nothing', () => {
    expect(session(personal, AUTHORITY, undefined)).toEqual(
      PolicyVerdict.Allow(),
    );
    expect(session(personal, BOB, undefined)).toEqual(
      PolicyVerdict.Deny({ reason: 'only-the-authority' }),
    );
    expect(session(member({ publicRead: true }), BOB, undefined)).toEqual(
      PolicyVerdict.Allow(),
    );
    expect(session(member(), BOB, undefined)).toEqual(
      PolicyVerdict.Deny({ reason: 'not-a-member' }),
    );
    expect(session(managed, BOB, undefined)).toEqual(PolicyVerdict.Ask());
  });
});
