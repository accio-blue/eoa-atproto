import { DID, NSID } from '@eoa/core';
import { Data, Schema } from 'effect';

/**
 * Space policies - proposal#119 and atproto#5764 (spaces alpha, 2026-10-29).
 *
 * A policy REPLACES `readPolicy`/`writePolicy`/`appAccess`: it is one open
 * union discriminated by `$type`, which both selects the rules and carries
 * their configuration. `com.atproto.space.{createSpace,updateSpace,deleteSpace,
 * getSpace}` replace the `simplespace` lifecycle methods; per-policy methods
 * live in the policy's namespace (`com.atproto.memberspace.*`,
 * `com.atproto.managedspace.*`).
 *
 * Is a policy a new record, or a view over what the host already has? Both, and
 * the split matters here:
 *
 * - The policy object is CONFIGURATION, not a record. In this package it is a
 *   view over the existing `SpaceAuthority` (authority / admins / recovery) plus
 *   a small policy state: it names which check decides a read or a write. It
 *   does not replace `MembershipEntry`, because that is a ROLE LOOKUP for grants
 *   (`space.ts`), while a memberspace entry is a `read`/`write` pair controlling
 *   whether the authority mints a credential or tracks a writer. They are
 *   different axes and the spec keeps them apart too: the member list is
 *   explicitly "not part of the `policy` object".
 * - The `com.atproto.space.policy` record is a DERIVED PUBLICATION of that
 *   configuration, written into the authority's own repo in the space only when
 *   `publishPolicy` (or `publishMembers`) is set. Configuration stays the truth;
 *   the records are a copy for readers, authoritative only in the authority's
 *   repo (`policyRecordOf` / `memberRecordsOf`).
 *
 * Under EVERY policy the authority's own account is authorized to read and
 * write without appearing on a member list or being approved by a managing app.
 */

export const PERSONAL_POLICY_TYPE = 'com.atproto.personalspace.policy';
export const MEMBER_POLICY_TYPE = 'com.atproto.memberspace.policy';
export const MANAGED_POLICY_TYPE = 'com.atproto.managedspace.policy';

/** The policy-agnostic lifecycle methods, and the per-policy ones that moved with the split. */
export const SPACE_METHODS = {
  createSpace: 'com.atproto.space.createSpace',
  updateSpace: 'com.atproto.space.updateSpace',
  deleteSpace: 'com.atproto.space.deleteSpace',
  getSpace: 'com.atproto.space.getSpace',
  clearRecords: 'com.atproto.space.clearRecords',
  removeWriter: 'com.atproto.space.removeWriter',
  putMember: 'com.atproto.memberspace.putMember',
  removeMember: 'com.atproto.memberspace.removeMember',
  listMembers: 'com.atproto.memberspace.listMembers',
  checkUserAccess: 'com.atproto.managedspace.checkUserAccess',
} as const;

/**
 * Fields keep the lexicon's optionality: an absent flag is the lexicon default
 * (`false`), read through `publicReadOf` / `publicWriteOf` / `publishPolicyOf`.
 * `allowedApps` absent means "any app"; an empty array is a SET allow-list with
 * nobody on it and is refused (`app-not-allowed`) - the spec distinguishes the
 * two cases only by "when set", so the distinction is made explicit here.
 */
export const PersonalPolicy = Schema.Struct({
  $type: Schema.Literal(PERSONAL_POLICY_TYPE),
});
export type PersonalPolicy = typeof PersonalPolicy.Type;

export const MemberPolicy = Schema.Struct({
  $type: Schema.Literal(MEMBER_POLICY_TYPE),
  publicRead: Schema.optionalKey(Schema.Boolean),
  publicWrite: Schema.optionalKey(Schema.Boolean),
  allowedApps: Schema.optionalKey(Schema.Array(Schema.String)),
  publishPolicy: Schema.optionalKey(Schema.Boolean),
  publishMembers: Schema.optionalKey(Schema.Boolean),
});
export type MemberPolicy = typeof MemberPolicy.Type;

export const ManagedPolicy = Schema.Struct({
  $type: Schema.Literal(MANAGED_POLICY_TYPE),
  /** A DID with an optional service fragment, e.g. `did:web:example.com#forum`. */
  managingApp: Schema.String,
  publishPolicy: Schema.optionalKey(Schema.Boolean),
});
export type ManagedPolicy = typeof ManagedPolicy.Type;

export const Policy = Schema.Union([
  PersonalPolicy,
  MemberPolicy,
  ManagedPolicy,
]);
export type Policy = typeof Policy.Type;

export const decodePolicy = Schema.decodeUnknownEffect(Policy, {
  onExcessProperty: 'error',
});

/** One member-list entry: required booleans, replaced together by `putMember`. */
export const MemberAccess = Schema.Struct({
  read: Schema.Boolean,
  write: Schema.Boolean,
});
export type MemberAccess = typeof MemberAccess.Type;

export const publicReadOf = (policy: Policy): boolean =>
  policy.$type === MEMBER_POLICY_TYPE && (policy.publicRead ?? false);

export const publicWriteOf = (policy: Policy): boolean =>
  policy.$type === MEMBER_POLICY_TYPE && (policy.publicWrite ?? false);

export const publishPolicyOf = (policy: Policy): boolean =>
  policy.$type === PERSONAL_POLICY_TYPE
    ? false
    : (policy.publishPolicy ?? false);

export const publishMembersOf = (policy: Policy): boolean =>
  policy.$type === MEMBER_POLICY_TYPE && (policy.publishMembers ?? false);

/**
 * `updateSpace` replaces the policy wholesale. A same-`$type` change is a
 * configuration change and keeps policy state; a different `$type` migrates the
 * space and DISCARDS it (a member list does not come back on migrating back).
 * The writer set is only re-evaluated "may" - the spec explicitly does not
 * promise it - so this package leaves the writer set alone on migration.
 */
export const policyStateSurvives = (previous: Policy, next: Policy): boolean =>
  previous.$type === next.$type;

export type PolicyDenial =
  | 'only-the-authority'
  | 'not-a-member'
  | 'member-has-no-read'
  | 'member-has-no-write'
  | 'app-not-allowed';

/** What a policy says about one user, before any I/O. */
export type PolicyVerdict = Data.TaggedEnum<{
  Allow: {};
  Deny: { readonly reason: PolicyDenial };
  /** A managed space cannot decide locally: the authority must ask `checkUserAccess`. */
  Ask: {};
}>;
export const PolicyVerdict = Data.taggedEnum<PolicyVerdict>();

/**
 * Whether this app is approved by the policy's `allowedApps`: an absent list approves every app,
 * a present one is a set — and an empty set approves nobody (the spec's only distinction).
 *
 * Exported because minting a credential has to ask it *even when the caller is the authority*:
 * `decideRead` short-circuits for the authority, which is right for a read and wrong for handing
 * an app a token.
 */
export const appApproved = (
  policy: Policy,
  app: string | undefined,
): boolean => {
  if (policy.$type !== MEMBER_POLICY_TYPE) {
    return true;
  }
  const allowed = policy.allowedApps;
  return allowed === undefined || (app !== undefined && allowed.includes(app));
};

const appVerdict = (
  policy: MemberPolicy,
  app: string | undefined,
): PolicyVerdict => {
  return appApproved(policy, app)
    ? PolicyVerdict.Allow()
    : PolicyVerdict.Deny({ reason: 'app-not-allowed' });
};

/**
 * Whether the user may be issued a space credential. `app` is the ATTESTED
 * `client_id` when the request carried a client attestation; `allowedApps` is
 * evaluated against it and applies to reads only.
 */
export const decideRead = (input: {
  readonly policy: Policy;
  readonly did: DID;
  readonly authority: DID;
  readonly member: MemberAccess | undefined;
  readonly app: string | undefined;
}): PolicyVerdict => {
  if (input.did === input.authority) {
    return PolicyVerdict.Allow();
  }
  switch (input.policy.$type) {
    case PERSONAL_POLICY_TYPE:
      return PolicyVerdict.Deny({ reason: 'only-the-authority' });
    case MANAGED_POLICY_TYPE:
      return PolicyVerdict.Ask();
    case MEMBER_POLICY_TYPE: {
      if (publicReadOf(input.policy)) {
        return appVerdict(input.policy, input.app);
      }
      if (input.member === undefined) {
        return PolicyVerdict.Deny({ reason: 'not-a-member' });
      }
      if (!input.member.read) {
        return PolicyVerdict.Deny({ reason: 'member-has-no-read' });
      }
      return appVerdict(input.policy, input.app);
    }
  }
};

/**
 * Whether a **session** may read: the policy's own answer, with no app dimension.
 *
 * `decideRead` answers "may this app be handed a credential", so it asks `allowedApps` even when no
 * app is presented — an empty set means nobody, which is right for minting a token and wrong for a
 * person reading with a session. A session is not an app: this is `decideRead` minus that question,
 * and it exists rather than being parameterised because the two answers differ in exactly that.
 */
export const decideSessionRead = (input: {
  readonly policy: Policy;
  readonly did: DID;
  readonly authority: DID;
  readonly member: MemberAccess | undefined;
}): PolicyVerdict => {
  if (input.did === input.authority) {
    return PolicyVerdict.Allow();
  }
  switch (input.policy.$type) {
    case PERSONAL_POLICY_TYPE:
      return PolicyVerdict.Deny({ reason: 'only-the-authority' });
    case MANAGED_POLICY_TYPE:
      return PolicyVerdict.Ask();
    case MEMBER_POLICY_TYPE: {
      if (publicReadOf(input.policy)) {
        return PolicyVerdict.Allow();
      }
      if (input.member === undefined) {
        return PolicyVerdict.Deny({ reason: 'not-a-member' });
      }
      if (!input.member.read) {
        return PolicyVerdict.Deny({ reason: 'member-has-no-read' });
      }
      return PolicyVerdict.Allow();
    }
  }
};

/** Whether the authority tracks and forwards this user's writes. No app dimension. */
export const decideWrite = (input: {
  readonly policy: Policy;
  readonly did: DID;
  readonly authority: DID;
  readonly member: MemberAccess | undefined;
}): PolicyVerdict => {
  if (input.did === input.authority) {
    return PolicyVerdict.Allow();
  }
  switch (input.policy.$type) {
    case PERSONAL_POLICY_TYPE:
      return PolicyVerdict.Deny({ reason: 'only-the-authority' });
    case MANAGED_POLICY_TYPE:
      return PolicyVerdict.Ask();
    case MEMBER_POLICY_TYPE: {
      if (publicWriteOf(input.policy)) {
        return PolicyVerdict.Allow();
      }
      if (input.member === undefined) {
        return PolicyVerdict.Deny({ reason: 'not-a-member' });
      }
      return input.member.write
        ? PolicyVerdict.Allow()
        : PolicyVerdict.Deny({ reason: 'member-has-no-write' });
    }
  }
};

export const POLICY_RECORD_COLLECTION = Schema.decodeSync(NSID)(
  'com.atproto.space.policy',
);
export const MEMBER_RECORD_COLLECTION = Schema.decodeSync(NSID)(
  'com.atproto.memberspace.member',
);

/** The collections a client may not write directly; the host publishes them. */
export const isPolicyRecordCollection = (collection: NSID): boolean =>
  collection === POLICY_RECORD_COLLECTION ||
  collection === MEMBER_RECORD_COLLECTION;

export interface PolicyRecord {
  readonly collection: NSID;
  readonly rkey: 'self';
  readonly value: { readonly policy: Policy };
}

export interface MemberRecord {
  readonly collection: NSID;
  readonly rkey: DID;
  readonly value: MemberAccess;
}

/** The `com.atproto.space.policy` record to publish, or `undefined` when `publishPolicy` is off. */
export const policyRecordOf = (policy: Policy): PolicyRecord | undefined =>
  publishPolicyOf(policy)
    ? {
        collection: POLICY_RECORD_COLLECTION,
        rkey: 'self',
        value: { policy },
      }
    : undefined;

/** The `com.atproto.memberspace.member` records to publish, keyed by the member's DID. */
export const memberRecordsOf = (input: {
  readonly policy: Policy;
  readonly members: ReadonlyMap<DID, MemberAccess>;
}): ReadonlyArray<MemberRecord> =>
  input.policy.$type === MEMBER_POLICY_TYPE && publishMembersOf(input.policy)
    ? [...input.members].map(([did, access]) => ({
        collection: MEMBER_RECORD_COLLECTION,
        rkey: did,
        value: access,
      }))
    : [];
