import { ATURI, DID, NSID } from '@eoa/core';
import { Effect, Layer, Option, Schema } from 'effect';

import { Membership } from './evaluate.js';
import { RecordKey } from './write-log.js';

/**
 * Spaces - permission-primitive.md sections 2.1 and 5.
 *
 * A space is an authorization and sync boundary, identified by
 * `(authority, type, skey)`: `authority` is the owning DID, `type` names the
 * kind of context, `skey` distinguishes two spaces of one authority and type.
 * Its address is `at://{authority}/{type}/{skey}` (the shape the `space` field
 * of a grant carries).
 *
 * Administration is two-tier (Roomy/arbiter's split): day-to-day `admins` and
 * a separate `recovery` root. Roles are MEMBERSHIP LOOKUPS, never grant
 * targets: a member stands for the role DIDs on their entry, expanded at read
 * time.
 */

export const Space = Schema.Struct({
  authority: DID,
  type: NSID,
  skey: RecordKey,
});
export type Space = typeof Space.Type;

/** The address of a space: `at://{authority}/{type}/{skey}`. */
export const spaceUriOf = (space: Space): ATURI =>
  Schema.decodeSync(ATURI)(
    `at://${space.authority}/${space.type}/${space.skey}`,
  );

/** The `(authority, type, skey)` of an at-uri, or `undefined` when it is not a space address. */
export const spaceFromUri = (uri: ATURI): Space | undefined => {
  const parts = uri.slice('at://'.length).split('/');
  if (parts.length !== 3) {
    return undefined;
  }
  const [authority, type, skey] = parts;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Space)({ authority, type, skey }),
  );
};

/**
 * `ing.lexicon.space` administration. The `recovery` root must be distinct
 * from `authority` and the day-to-day `admins` - it is the separate, ultimate
 * way back in (permission-primitive.md section 5.2).
 */
export const SpaceAuthority = Schema.Struct({
  space: ATURI,
  authority: DID,
  admins: Schema.Array(DID),
  recovery: DID,
});
export type SpaceAuthority = typeof SpaceAuthority.Type;

export const isAuthority = (config: SpaceAuthority, did: DID): boolean =>
  did === config.authority;

export const isAdmin = (config: SpaceAuthority, did: DID): boolean =>
  config.admins.includes(did);

export const isRecovery = (config: SpaceAuthority, did: DID): boolean =>
  did === config.recovery;

/** Who may rewrite the space policy: the authority, a day-to-day admin, or recovery. */
export const mayConfigure = (config: SpaceAuthority, did: DID): boolean =>
  isAuthority(config, did) || isAdmin(config, did) || isRecovery(config, did);

/** The recovery root is separate from the authority and the day-to-day admins. */
export const recoveryIsDistinct = (config: SpaceAuthority): boolean =>
  config.recovery !== config.authority &&
  !config.admins.includes(config.recovery);

/** One member of a space and the role DIDs it stands for (a role is a lookup, not a grant target). */
export const MembershipEntry = Schema.Struct({
  space: ATURI,
  member: DID,
  roles: Schema.Array(DID),
});
export type MembershipEntry = typeof MembershipEntry.Type;

/** The role DIDs `did` stands for in `space`; empty when the list has no entry for it. */
export const rolesOf = (
  entries: ReadonlyArray<MembershipEntry>,
  space: ATURI,
  did: DID,
): ReadonlyArray<DID> => [
  ...new Set(
    entries
      .filter((entry) => entry.space === space && entry.member === did)
      .flatMap((entry) => entry.roles),
  ),
];

/**
 * A `Membership` lookup over a member list: `expand(space, did)` returns the
 * role DIDs the caller stands for, so a grant addressed to a role matches. The
 * member list itself has no failure mode here; a store that can fail plugs in
 * behind the same service.
 */
export const layerMembershipFrom = (
  entries: ReadonlyArray<MembershipEntry>,
): Layer.Layer<Membership> =>
  Layer.succeed(
    Membership,
    Membership.of({
      expand: (space, did) => Effect.succeed(rolesOf(entries, space, did)),
    }),
  );
