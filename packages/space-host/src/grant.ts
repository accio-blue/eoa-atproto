import { ATURI, DID, NSID } from '@eoa/core';
import { Schema } from 'effect';

/**
 * `ing.lexicon.grant` and `ing.lexicon.grant.revoke` - permission-primitive.md
 * section 9.1.
 *
 * A grant is issued by the space authority and stored IN the space. It is
 * POSITIVE-ONLY: there is no deny field, and `decodeGrant` decodes with
 * `onExcessProperty: "error"` so a stray `deny` (or any unmodelled key) is a
 * refusal rather than a silently dropped rule.
 */

export const GRANT_NSID = 'ing.lexicon.grant';
export const GRANT_REVOKE_NSID = 'ing.lexicon.grant.revoke';

export type CidString = typeof CidString.Type;
export const CidString = Schema.String.check(Schema.isNonEmpty()).pipe(
  Schema.brand('CID'),
);

/** `com.atproto.repo.strongRef`. */
export type StrongRef = typeof StrongRef.Type;
export const StrongRef = Schema.Struct({ uri: ATURI, cid: CidString });

export const Action = Schema.Literals(['view', 'write']);
export type Action = typeof Action.Type;

/**
 * One field of a record, as a JSON Pointer (RFC 6901): `/startedAt`, `/data/name`.
 *
 * A selector that names fields promises a **projection**: a reader gets those fields and no others.
 * That is narrower than a lens, which says what shape a whole record is returned in; a grant may
 * carry both, and then both bind.
 */
export type FieldPath = typeof FieldPath.Type;
export const FieldPath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^\//u),
);

/**
 * Scope is flat: a whole collection, or one exact record — and, optionally, which fields of it.
 *
 * `fields` is additive: a selector without it promises the whole record, exactly as before, and a
 * request that names no fields never matches a selector that names some (fail-closed: a projection
 * cannot be silently widened to a record).
 */
export const CollectionSelector = Schema.Struct({
  collection: NSID,
  fields: Schema.optionalKey(Schema.NonEmptyArray(FieldPath)),
});
export const RecordSelector = Schema.Struct({
  record: StrongRef,
  fields: Schema.optionalKey(Schema.NonEmptyArray(FieldPath)),
});
export const Selector = Schema.Union([CollectionSelector, RecordSelector]);
export type Selector = typeof Selector.Type;

/** WHAT SHAPE a view returns: an nsid pinned to a cid. */
export type LensRef = typeof LensRef.Type;
export const LensRef = Schema.Struct({ nsid: NSID, cid: CidString });

const Seconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Consumer-side retention policy; carried by the grant, never judged by `checkAccess`. */
export const Retention = Schema.Struct({
  materialize: Schema.Literals(['allowed', 'forbidden']),
  maxAge: Schema.optionalKey(Seconds),
  revalidate: Schema.optionalKey(Schema.Boolean),
  storeUntil: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type Retention = typeof Retention.Type;

export const Grant = Schema.Struct({
  space: ATURI,
  subject: DID,
  selectors: Schema.NonEmptyArray(Selector),
  actions: Schema.NonEmptyArray(Action),
  lens: Schema.optionalKey(LensRef),
  expiry: Schema.optionalKey(Schema.DateTimeUtcFromString),
  retention: Schema.optionalKey(Retention),
  purpose: Schema.optionalKey(Schema.String),
  consent: Schema.optionalKey(ATURI),
  issuedBy: DID,
  createdAt: Schema.DateTimeUtcFromString,
});
export type Grant = typeof Grant.Type;

/** Revocation is an APPEND-ONLY companion record, never a delete. */
export const GrantRevoke = Schema.Struct({
  grant: StrongRef,
  revokedAt: Schema.DateTimeUtcFromString,
  reason: Schema.optionalKey(Schema.String),
});
export type GrantRevoke = typeof GrantRevoke.Type;

/**
 * A backing lookup (grant store, membership, lens registry, revocation log)
 * could not answer. The evaluator turns this into a denial, never an allow.
 */
export class LookupError extends Schema.TaggedError<LookupError>()(
  'LookupError',
  {
    source: Schema.Literals([
      'grant-store',
      'membership',
      'lens-registry',
      'revocation-log',
      'author-keys',
    ]),
    message: Schema.String,
  },
) {}

const strict = { onExcessProperty: 'error' } as const;

export const decodeGrant = Schema.decodeUnknownEffect(Grant, strict);
export const decodeGrantRevoke = Schema.decodeUnknownEffect(
  GrantRevoke,
  strict,
);

/** Grant-level self-read: the subject and the issuer may read it, nobody else. */
export const mayReadGrant = (
  did: DID,
  grant: Pick<Grant, 'issuedBy' | 'subject'>,
): boolean => did === grant.subject || did === grant.issuedBy;
