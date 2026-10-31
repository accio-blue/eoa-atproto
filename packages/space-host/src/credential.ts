import { Effect, Option, Predicate, Schema } from 'effect';
import {
  type MemberAccess,
  type Policy,
  type PolicyDenial,
  decideRead,
} from './policy.js';
import {
  type PrivateKey,
  type PublicKey,
  base64urlDecode,
  base64urlEncode,
  exportPublicKey,
  sha256,
  sign,
  verify,
} from '@eoa/crypto';
import { DID } from '@eoa/core';

/**
 * The space credential: what a reader presents to a space host, and what the host verifies
 * without a lookup (spaces `0016`, bean `frxd`).
 *
 * The authority mints it for **one app and one space**, bound to the app's DPoP key (`cnf.jkt`,
 * RFC 7638), short-lived. The authority's policy row stays the truth: a minted token's `exp` is
 * the documented bound on revocation latency, and `decideRead` is what decides whether anything is
 * minted at all. Verification is stateless — signature, audience, space, expiry, and that the
 * caller holds the key the token names — so a space host can answer without the authority's store.
 *
 * This is the *blunt* space credential, not the finer `net.effects.grant`: the AppView reads as
 * infrastructure (all-or-nothing at the space boundary), and the grant stays the primitive for
 * sharing between people (`h31z`).
 */

/** The multi-use, DPoP-bound credential's life: the shape from the spec's cascade, 2 hours. */
export const SPACE_CREDENTIAL_TTL_SECONDS = 7200;

const HEADER = base64urlEncode(
  new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT' })),
);

/** The claims as this package writes them. `cnf.jkt` is the DPoP key the token is bound to. */
export const SpaceCredentialSchema = Schema.Struct({
  iss: Schema.String,
  /** The space's authority: `did:plc:…`, the issuer of this token. */
  aud: Schema.String,
  /** The space the credential opens, as `atproto:<authority>:<type>:<skey>`. */
  space: Schema.String,
  /** The app the authority approved — the value `allowedApps` is checked against. */
  sub: Schema.String,
  cnf: Schema.Struct({ jkt: Schema.String }),
  iat: Schema.Finite,
  exp: Schema.Finite,
});
export type SpaceCredential = typeof SpaceCredentialSchema.Type;

export class CredentialError extends Schema.TaggedError<CredentialError>()(
  'CredentialError',
  { reason: Schema.String },
) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/** The DPoP key thumbprint a `cnf.jkt` carries: base64url(SHA-256(canonical JWK)), RFC 7638. */
export const jktOf = (publicJwk: {
  readonly crv: string;
  readonly kty: string;
  readonly x: string;
  readonly y: string;
}) =>
  Effect.gen(function* () {
    // RFC 7638: the required members, lexicographic order, no whitespace.
    const canonical = JSON.stringify({
      crv: publicJwk.crv,
      kty: publicJwk.kty,
      x: publicJwk.x,
      y: publicJwk.y,
    });
    return base64urlEncode(yield* sha256(new TextEncoder().encode(canonical)));
  });

/**
 * The thumbprint of a key this package holds only as a `PublicKey` — what a credential's `cnf.jkt`
 * is compared against. `undefined` when the key does not export as a JWK, because a key that cannot
 * be named cannot be the one a token is bound to.
 */
export const jktOfKey = (key: PublicKey): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const jwk = yield* exportPublicKey(key).pipe(Effect.option);
    if (Option.isNone(jwk)) {
      return undefined;
    }
    const { crv, kty, x, y } = jwk.value;
    if (
      crv === undefined ||
      kty === undefined ||
      x === undefined ||
      y === undefined
    ) {
      return undefined;
    }
    const thumbprint = yield* jktOf({ crv, kty, x, y }).pipe(Effect.option);
    return Option.getOrUndefined(thumbprint);
  });

/**
 * Mint one credential. The caller has already decided that this app may read this space
 * (`decideRead`); this function only says it, in a form the space host can check alone.
 */
export const mintSpaceCredential = (params: {
  /** The space's authority: who decided, and whose key signs. */
  readonly issuer: string;
  /** The space host that will verify it: `did:web:pds.example`, not the authority. */
  readonly audience: string;
  readonly key: PrivateKey;
  readonly space: string;
  readonly app: string;
  /** The app's DPoP key thumbprint: what makes a stolen token useless without the key. */
  readonly jkt: string;
  readonly now: number;
  readonly ttl?: number | undefined;
}): Effect.Effect<string, CredentialError> =>
  Effect.gen(function* () {
    const iat = Math.floor(params.now / 1000);
    const exp = iat + (params.ttl ?? SPACE_CREDENTIAL_TTL_SECONDS);
    const body = base64urlEncode(
      new TextEncoder().encode(
        encodeJson({
          iss: params.issuer,
          aud: params.audience,
          space: params.space,
          sub: params.app,
          cnf: { jkt: params.jkt },
          iat,
          exp,
        }),
      ),
    );
    const signed = `${HEADER}.${body}`;
    const signature = yield* sign(
      params.key,
      new TextEncoder().encode(signed),
    ).pipe(
      Effect.mapError(
        (error) => new CredentialError({ reason: String(error) }),
      ),
    );
    return `${signed}.${base64urlEncode(signature)}`;
  });

export type CredentialVerdict =
  | { readonly ok: true; readonly credential: SpaceCredential }
  | {
      readonly ok: false;
      readonly reason:
        | 'not-a-token'
        | 'not-ours'
        | 'bad-signature'
        | 'bad-payload'
        | 'expired'
        | 'wrong-space'
        | 'wrong-audience'
        | 'not-bound'
        | 'wrong-app';
    };

/**
 * Check one credential, statelessly.
 *
 * `jkt` is the thumbprint of the key the caller is actually holding (the DPoP proof's key): a
 * token names a key, and a token presented by a caller who does not hold it opens nothing — which
 * is what makes a leaked credential harmless without its key.
 */
export const verifySpaceCredential = (params: {
  readonly token: string;
  readonly key: PublicKey;
  readonly audience: string;
  readonly space: string;
  readonly now: number;
  readonly jkt: string | undefined;
  readonly app?: string | undefined;
}): Effect.Effect<CredentialVerdict> =>
  Effect.gen(function* () {
    const parts = params.token.split('.');
    const [header, body, signature] = parts;
    if (
      parts.length !== 3 ||
      header === undefined ||
      body === undefined ||
      signature === undefined
    ) {
      return { ok: false as const, reason: 'not-a-token' as const };
    }
    if (header !== HEADER) {
      return { ok: false as const, reason: 'not-ours' as const };
    }
    const genuine = yield* verify(
      params.key,
      new TextEncoder().encode(`${header}.${body}`),
      base64urlDecode(signature),
    ).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!genuine) {
      return { ok: false as const, reason: 'bad-signature' as const };
    }
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(SpaceCredentialSchema))(
        new TextDecoder().decode(base64urlDecode(body)),
      ),
    );
    if (decoded === undefined) {
      return { ok: false as const, reason: 'bad-payload' as const };
    }
    if (decoded.exp <= Math.floor(params.now / 1000)) {
      return { ok: false as const, reason: 'expired' as const };
    }
    if (decoded.space !== params.space) {
      return { ok: false as const, reason: 'wrong-space' as const };
    }
    if (decoded.aud !== params.audience) {
      return { ok: false as const, reason: 'wrong-audience' as const };
    }
    if (params.app !== undefined && decoded.sub !== params.app) {
      return { ok: false as const, reason: 'wrong-app' as const };
    }
    if (params.jkt === undefined || decoded.cnf.jkt !== params.jkt) {
      return { ok: false as const, reason: 'not-bound' as const };
    }
    return { ok: true as const, credential: decoded };
  });

export type IssueVerdict =
  | { readonly ok: true; readonly token: string }
  | {
      readonly ok: false;
      readonly reason:
        | PolicyDenial
        | 'no-app'
        | 'the-managing-app-decides'
        | 'cannot-sign';
    };

/**
 * The authority's decision, as a credential: `decideRead` (the policy row, the member list, the
 * attested app) says whether this reader may open this space, and the token says it in a form the
 * space host verifies alone.
 *
 * An allow without an attested app mints nothing: `allowedApps` is evaluated against an app, and a
 * credential with no `sub` would be one nobody approved.
 */
export const credentialFor = (params: {
  readonly policy: Policy;
  readonly did: DID;
  readonly authority: DID;
  /** The space host the token is for: the verifier, not the issuer. */
  readonly audience: string;
  readonly member: MemberAccess | undefined;
  readonly app: string | undefined;
  readonly space: string;
  readonly jkt: string;
  readonly key: PrivateKey;
  readonly now: number;
  readonly ttl?: number | undefined;
}): Effect.Effect<IssueVerdict> =>
  Effect.gen(function* () {
    const verdict = decideRead({
      policy: params.policy,
      did: params.did,
      authority: params.authority,
      member: params.member,
      app: params.app,
    });
    if (Predicate.isTagged(verdict, 'Deny')) {
      return { ok: false as const, reason: verdict.reason };
    }
    if (Predicate.isTagged(verdict, 'Ask')) {
      return {
        ok: false as const,
        reason: 'the-managing-app-decides' as const,
      };
    }
    if (params.app === undefined) {
      return { ok: false as const, reason: 'no-app' as const };
    }
    return yield* mintSpaceCredential({
      issuer: params.authority,
      audience: params.audience,
      key: params.key,
      space: params.space,
      app: params.app,
      jkt: params.jkt,
      now: params.now,
      ...(params.ttl === undefined ? {} : { ttl: params.ttl }),
    }).pipe(
      Effect.map((token) => ({ ok: true as const, token })),
      Effect.catch(() =>
        Effect.succeed({ ok: false as const, reason: 'cannot-sign' as const }),
      ),
    );
  });
