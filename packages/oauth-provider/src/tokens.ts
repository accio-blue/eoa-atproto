import {
  DpopError,
  JWT_ALGORITHM,
  JwtError,
  segmentFor,
  signJwt,
  splitJwt,
  valueFrom,
  verifyJwtSignature,
  verifyProof,
} from '@eoa/oauth';
import { Effect, Schema } from 'effect';
import type { TokenKeysShape } from './keys.js';
import { base64urlEncode } from '@eoa/crypto';

/**
 * The provider's tokens.
 *
 * An access token is an ES256 JWT bound to the client's DPoP key (`cnf.jkt`), which
 * is what makes it a *proof*-of-possession token rather than a bearer token: a stolen
 * token is useless without the private key that makes the proofs. So `cnf` is not
 * optional here, and `authenticateRequest` is the other half of the same rule — a
 * token is only accepted with a proof from the key it names.
 *
 * Both halves are checks a resource server performs on its own, without calling the
 * provider back, which is the point of signing rather than storing tokens.
 */

/** Reported when a token is not one we can accept. */
export class AccessTokenError extends Schema.TaggedError<AccessTokenError>()(
  'AccessTokenError',
  { message: Schema.String },
) {}

const fromJwt = (cause: JwtError): AccessTokenError =>
  new AccessTokenError({ message: cause.message });

/**
 * `typ` is `at+jwt`, as atproto specifies, so a token cannot be passed off as some
 * other kind of JWT — and so a service-auth token cannot be passed off as this one.
 */
const HeaderSchema = Schema.Struct({
  alg: Schema.String,
  typ: Schema.Literal('at+jwt'),
  kid: Schema.String,
});

const PayloadSchema = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  scope: Schema.String,
  /**
   * The credential the token was issued for, opaque to the provider. A resource
   * server uses it to refuse a token whose credential has since been revoked,
   * without asking the provider back.
   */
  credential: Schema.String,
  iat: Schema.Finite,
  exp: Schema.Finite,
  jti: Schema.String,
  cnf: Schema.Struct({ jkt: Schema.String }),
});

/** What an access token asserts. */
export type AccessTokenClaims = Schema.Schema.Type<typeof PayloadSchema>;

/** A unique token id. */
const newJti = (): string =>
  base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

/** The default access-token lifetime, in seconds. */
const DEFAULT_TTL_SECONDS = 3600;

/** Issue an access token for one account, bound to one DPoP key. */
export const issueAccessToken = (params: {
  readonly keys: TokenKeysShape;
  readonly issuer: string;
  readonly audience: string;
  readonly did: string;
  readonly scope: string;
  /** The credential this token acts for; the resource server re-checks it. */
  readonly credential: string;
  /** The client's DPoP key confirmation — the `cnf.jkt` this token is bound to. */
  readonly jkt: string;
  readonly now: number;
  readonly ttlSeconds?: number;
}): Effect.Effect<string, AccessTokenError> =>
  Effect.gen(function* () {
    const headerSegment = segmentFor({
      codec: Schema.fromJsonString(HeaderSchema),
      value: { alg: JWT_ALGORITHM, typ: 'at+jwt', kid: params.keys.kid },
    });
    const payloadSegment = segmentFor({
      codec: Schema.fromJsonString(PayloadSchema),
      value: {
        iss: params.issuer,
        aud: params.audience,
        sub: params.did,
        scope: params.scope,
        credential: params.credential,
        iat: params.now,
        exp: params.now + (params.ttlSeconds ?? DEFAULT_TTL_SECONDS),
        jti: newJti(),
        cnf: { jkt: params.jkt },
      },
    });

    return yield* signJwt({
      headerSegment,
      payloadSegment,
      key: params.keys.privateKey,
    }).pipe(Effect.mapError(fromJwt));
  });

/**
 * Verify a token on its own: signature, algorithm, key, issuer, audience, expiry.
 *
 * This is the check a resource server makes when it trusts the provider's published
 * keys — no call back to us, and no session lookup.
 */
export const verifyAccessToken = (params: {
  readonly keys: TokenKeysShape;
  readonly token: string;
  readonly issuer: string;
  readonly audience: string;
  readonly now: number;
}): Effect.Effect<AccessTokenClaims, AccessTokenError> =>
  Effect.gen(function* () {
    const { header: headerSegment, body } = yield* splitJwt(params.token).pipe(
      Effect.mapError(fromJwt),
    );

    const header = yield* valueFrom({
      schema: HeaderSchema,
      segment: headerSegment,
      message: 'the token header is not an access token header',
    }).pipe(Effect.mapError(fromJwt));
    if (header.alg !== JWT_ALGORITHM) {
      // loud and specific, for the same reason the core is: a silently rejected
      // algorithm looks like a broken signature
      return yield* new AccessTokenError({
        message: `this build verifies ${JWT_ALGORITHM} only; the token says ${header.alg}`,
      });
    }
    if (header.kid !== params.keys.kid) {
      return yield* new AccessTokenError({
        message: 'the token was signed with a key we do not hold',
      });
    }

    yield* verifyJwtSignature({
      token: params.token,
      key: params.keys.privateKey.publicKey,
    }).pipe(Effect.mapError(fromJwt));

    const claims = yield* valueFrom({
      schema: PayloadSchema,
      segment: body,
      message: 'the token payload is not an access token claim',
    }).pipe(Effect.mapError(fromJwt));

    if (claims.iss !== params.issuer) {
      return yield* new AccessTokenError({
        message: `the token was issued by ${claims.iss}, not by us`,
      });
    }
    if (claims.aud !== params.audience) {
      return yield* new AccessTokenError({
        message: `the token is addressed to ${claims.aud}, not to us`,
      });
    }
    if (claims.exp <= params.now) {
      return yield* new AccessTokenError({ message: 'the token has expired' });
    }

    return claims;
  });

/** Who a signed request is from, once it has been authenticated. */
export interface Principal {
  readonly did: string;
  readonly scope: string;
  /** The credential the token acts for, so a resource server can re-check it. */
  readonly credential: string;
  /** The DPoP key the token and the proof agree on. */
  readonly jkt: string;
  /**
   * The proof's id, for the caller's replay store — this function keeps no
   * nonce or replay state of its own, because a resource server that trusts
   * signatures has no session to keep it in. (The authorization-server endpoints
   * do keep one; see `nonces.ts`.)
   */
  readonly jti: string;
}

/**
 * Authenticate a signed request: the token *and* a proof from the key the token names.
 *
 * Either half alone is not enough. A valid token presented with someone else's proof
 * is a stolen token; a valid proof for a token that is not bound to it is a proof for
 * a different request. The `htm`/`htu` binding and the freshness window are the core's.
 */
export const authenticateRequest = (params: {
  readonly keys: TokenKeysShape;
  readonly token: string;
  readonly proof: string;
  readonly htm: string;
  readonly htu: string;
  readonly now: number;
  readonly issuer: string;
  readonly audience: string;
  readonly windowSeconds?: number;
}): Effect.Effect<Principal, AccessTokenError | DpopError> =>
  Effect.gen(function* () {
    const claims = yield* verifyAccessToken({
      keys: params.keys,
      token: params.token,
      issuer: params.issuer,
      audience: params.audience,
      now: params.now,
    });

    // the proof is bound to the token it travels with (`ath`), so this is where a
    // proof pulled from another request stops being usable
    const proof = yield* verifyProof({
      proof: params.proof,
      htm: params.htm,
      htu: params.htu,
      now: params.now,
      accessToken: params.token,
      ...(params.windowSeconds === undefined
        ? {}
        : { windowSeconds: params.windowSeconds }),
    });

    if (proof.jkt !== claims.cnf.jkt) {
      return yield* new AccessTokenError({
        message: 'the proof is not from the key this token is bound to',
      });
    }

    return {
      did: claims.sub,
      scope: claims.scope,
      credential: claims.credential,
      jkt: proof.jkt,
      jti: proof.jti,
    };
  });
