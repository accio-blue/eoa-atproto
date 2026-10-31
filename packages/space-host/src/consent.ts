import { ATURI, DID } from '@eoa/core';
import { Schema } from 'effect';

import { StrongRef } from './grant.js';

/**
 * Double consent - permission-primitive.md section 9.2.8.
 *
 * A grant is only created by an explicit act of the data owner, so two records
 * can stand behind it:
 *
 * - a CONNECTION record: the mutual opt-in between two parties. Each party
 *   writes its own half, holding a strongRef to the other party's half, so a
 *   connection only holds when BOTH halves are present.
 * - a GRANT-ACCEPTANCE record: the subject's acceptance of one exact grant.
 *
 * One is required - and referenced by the grant's `consent` field - when the
 * data is schema-marked USER DATA or the `purpose` is new. Everything here is
 * pure; the host stores the records and passes them in.
 */

export const CONNECTION_NSID = 'ing.lexicon.connection';
export const GRANT_ACCEPTANCE_NSID = 'ing.lexicon.grant.acceptance';

/** One party's half of a connection: `subject` is the other party, `connection` strongRefs their half. */
export const Connection = Schema.Struct({
  subject: DID,
  connection: StrongRef,
  createdAt: Schema.DateTimeUtcFromString,
});
export type Connection = typeof Connection.Type;

/** A subject's acceptance of one grant (its strongRef, so an edited grant needs a new acceptance). */
export const GrantAcceptance = Schema.Struct({
  grant: StrongRef,
  acceptedBy: DID,
  acceptedAt: Schema.DateTimeUtcFromString,
});
export type GrantAcceptance = typeof GrantAcceptance.Type;

const strict = { onExcessProperty: 'error' } as const;

export const decodeConnection = Schema.decodeUnknownEffect(Connection, strict);
export const decodeGrantAcceptance = Schema.decodeUnknownEffect(
  GrantAcceptance,
  strict,
);

/** A stored connection record: its strongRef, the party that wrote it, and its body. */
export interface StoredConnection {
  readonly ref: StrongRef;
  readonly author: DID;
  readonly connection: Connection;
}

/** A stored grant-acceptance record: its strongRef and its body. */
export interface StoredGrantAcceptance {
  readonly ref: StrongRef;
  readonly acceptance: GrantAcceptance;
}

/** Consent is demanded when the data is schema-marked USER DATA or the `purpose` is new. */
export const consentRequired = (flags: {
  readonly userData?: boolean;
  readonly newPurpose?: boolean;
}): boolean => flags.userData === true || flags.newPurpose === true;

/**
 * A mutual connection between `a` and `b`: each has a half naming the other and
 * strongRef-ing the other's half. One half alone is an opt-in, not a connection.
 */
export const isMutualConnection = (
  records: ReadonlyArray<StoredConnection>,
  a: DID,
  b: DID,
): boolean =>
  records.some(
    (mine) =>
      mine.author === a &&
      mine.connection.subject === b &&
      records.some(
        (theirs) =>
          theirs.author === b &&
          theirs.connection.subject === a &&
          theirs.ref.uri === mine.connection.connection.uri &&
          mine.ref.uri === theirs.connection.connection.uri,
      ),
  );

/** An acceptance of exactly THIS grant, written by the subject it names. */
export const acceptanceSatisfies = (
  records: ReadonlyArray<StoredGrantAcceptance>,
  grantRef: StrongRef,
  subject: DID,
): boolean =>
  records.some(
    (stored) =>
      stored.acceptance.grant.uri === grantRef.uri &&
      stored.acceptance.grant.cid === grantRef.cid &&
      stored.acceptance.acceptedBy === subject,
  );

export type ConsentFailure =
  | 'missing'
  | 'unknown-record'
  | 'not-mutual'
  | 'grant-mismatch';

export interface ConsentInput {
  readonly grantRef: StrongRef;
  readonly issuedBy: DID;
  readonly subject: DID;
  /** The grant's `consent` field, when it carries one. */
  readonly consent?: ATURI;
  readonly connections: ReadonlyArray<StoredConnection>;
  readonly acceptances: ReadonlyArray<StoredGrantAcceptance>;
  readonly userData?: boolean;
  readonly newPurpose?: boolean;
}

/**
 * The first way the consent gate fails, or `undefined` when it holds (including
 * when consent is not demanded). FAIL-CLOSED in the caller: an unknown or
 * mismatched reference withholds the grant, it does not pass it.
 */
export const consentFailure = (
  input: ConsentInput,
): ConsentFailure | undefined => {
  if (!consentRequired(input)) {
    return undefined;
  }
  if (input.consent === undefined) {
    return 'missing';
  }
  if (input.connections.some((stored) => stored.ref.uri === input.consent)) {
    return isMutualConnection(input.connections, input.issuedBy, input.subject)
      ? undefined
      : 'not-mutual';
  }
  const acceptance = input.acceptances.find(
    (stored) => stored.ref.uri === input.consent,
  );
  if (acceptance === undefined) {
    return 'unknown-record';
  }
  return acceptance.acceptance.grant.uri === input.grantRef.uri &&
    acceptance.acceptance.grant.cid === input.grantRef.cid &&
    acceptance.acceptance.acceptedBy === input.subject
    ? undefined
    : 'grant-mismatch';
};

/** Whether the consent gate holds: consent not demanded, or its record valid. */
export const consentHolds = (input: ConsentInput): boolean =>
  consentFailure(input) === undefined;
