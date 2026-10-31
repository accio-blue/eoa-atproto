import { Effect, Option, Schema } from 'effect';
import {
  type PrivateKey,
  type PublicKey,
  base64urlDecode,
  base64urlEncode,
  sign,
  verify,
  verifySecp256k1,
} from '@eoa/crypto';

/**
 * Session tokens: two scopes, because a refresh token must not be usable as an
 * access token. Both carry `jti` — the session id — and that is deliberate: the
 * token proves *which session* is speaking, and the session row is what decides
 * whether it still may. A signature check alone would leave a revoked session
 * working until its token expired, which is the wrong side of "revoked
 * promptly".
 */

export const ACCESS_SCOPE = 'com.atproto.access';

export const REFRESH_SCOPE = 'com.atproto.refresh';

export const ACCESS_TTL_SECONDS = 2 * 60 * 60;

export const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60;

const TokenPayloadSchema = Schema.Struct({
  scope: Schema.Union([
    Schema.Literal(ACCESS_SCOPE),
    Schema.Literal(REFRESH_SCOPE),
  ]),
  sub: Schema.String,
  aud: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
  jti: Schema.String,
});

export type TokenPayload = Schema.Schema.Type<typeof TokenPayloadSchema>;

export type TokenScope = TokenPayload['scope'];

/** A token that is not one, is not ours, or is no longer good. */
export class InvalidToken extends Schema.TaggedError<InvalidToken>()(
  'InvalidToken',
  { reason: Schema.String },
) {}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const utf8 = (value: string) => encoder.encode(value);

/** The only header we issue, so the only one we accept. */
const JWT_HEADER = base64urlEncode(
  utf8(JSON.stringify({ alg: 'ES256', typ: 'JWT' })),
);

/**
 * The key a foreign DID proves control with: whichever curve its document names.
 *
 * The two halves cannot be one type, because WebCrypto holds the first and not the second: a P-256
 * key is a `CryptoKey`, and a secp256k1 one is the `did:key` that noble verifies against.
 */
export type ProofKey =
  | { readonly curve: 'p256'; readonly key: PublicKey }
  | { readonly curve: 'secp256k1'; readonly didKey: string };

/**
 * The session a token was minted for, and who it belongs to.
 *
 * A refresh token is **not** rotated: it stays good for its whole life, and
 * `deleteSession` is what ends it. Rotation would mean a client that retries a
 * refresh after a dropped response gets logged out, which is worse than the
 * window it closes here.
 *
 * // ponytail: no rotation window. Add a `seq` claim plus a grace period for
 * // the previous one when clients need retry-tolerant refresh.
 */
export interface TokenRequest {
  readonly key: PrivateKey;
  readonly did: string;
  readonly audience: string;
  readonly sessionId: string;
  readonly now: number;
}

const signPayload = (
  key: PrivateKey,
  payload: TokenPayload | ServiceAuthPayload,
) =>
  Effect.gen(function* () {
    const body = base64urlEncode(utf8(JSON.stringify(payload)));
    const signed = `${JWT_HEADER}.${body}`;
    const signature = yield* sign(key, utf8(signed));
    return `${signed}.${base64urlEncode(signature)}`;
  });

export const accessToken = (request: TokenRequest) =>
  signPayload(request.key, {
    scope: ACCESS_SCOPE,
    sub: request.did,
    aud: request.audience,
    iat: Math.floor(request.now / 1000),
    exp: Math.floor(request.now / 1000) + ACCESS_TTL_SECONDS,
    jti: request.sessionId,
  });

export const refreshToken = (request: TokenRequest) =>
  signPayload(request.key, {
    scope: REFRESH_SCOPE,
    sub: request.did,
    aud: request.audience,
    iat: Math.floor(request.now / 1000),
    exp: Math.floor(request.now / 1000) + REFRESH_TTL_SECONDS,
    jti: request.sessionId,
  });

export interface VerifyRequest {
  readonly key: PublicKey;
  readonly token: string;
  readonly audience: string;
  readonly scope: TokenScope;
  readonly now: number;
}

/**
 * Verify a token's signature, then its claims. `alg` is never read from the
 * token: we verify with the one algorithm we issue, so `alg: none` is not a
 * thing that can be asked for.
 */
export const verifyToken = (request: VerifyRequest) =>
  Effect.gen(function* () {
    const parts = request.token.split('.');
    const header = parts[0];
    const body = parts[1];
    const signature = parts[2];
    if (
      parts.length !== 3 ||
      header === undefined ||
      body === undefined ||
      signature === undefined
    ) {
      return yield* Effect.fail(new InvalidToken({ reason: 'not a token' }));
    }
    if (header !== JWT_HEADER) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'not a token we issue' }),
      );
    }
    const genuine = yield* verify(
      request.key,
      utf8(`${header}.${body}`),
      base64urlDecode(signature),
    );
    if (!genuine) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'the signature does not verify' }),
      );
    }
    const decoded = Schema.decodeUnknownOption(
      Schema.fromJsonString(TokenPayloadSchema),
    )(decoder.decode(base64urlDecode(body)));
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'the payload does not parse' }),
      );
    }
    const payload = decoded.value;
    if (payload.aud !== request.audience) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'not for this server' }),
      );
    }
    if (payload.scope !== request.scope) {
      return yield* Effect.fail(
        new InvalidToken({ reason: `not a ${request.scope} token` }),
      );
    }
    if (payload.exp <= Math.floor(request.now / 1000)) {
      return yield* Effect.fail(new InvalidToken({ reason: 'expired' }));
    }
    return payload;
  });

/**
 * The token that proves an account's DID to another service: what `getServiceAuth` mints.
 *
 * It is the **source** half of a move. A destination accepts `createAccount` for a DID it does not
 * yet host only when the caller proves control of it, and this is that proof: a JWT signed by the
 * key the DID's *document* names, addressed to the service that will read it, for the method it
 * may be used on. `lxm` is what keeps it narrow — one minted to write a record is not one to
 * delete an account — and `aud` is a DID rather than a URL, which is what makes it checkable by
 * whoever resolves the issuer.
 *
 * It is deliberately **not** shaped like a session token: no scope, no `jti`, no session row. The
 * server that verifies it is not this one, so there is nothing here for it to look up — the
 * signature is the whole of the claim.
 */
export interface ServiceAuthRequest {
  readonly key: PrivateKey;
  /** The DID the token is issued *for*: the account whose identity is being proven. */
  readonly iss: string;
  /** The DID (or service) it is addressed to, which that service checks against itself. */
  readonly aud: string;
  readonly lxm?: string | undefined;
  readonly now: number;
  readonly lifetimeSeconds?: number | undefined;
}

/** A minute, which is the spec's default and generous: it is presented as soon as it is minted. */
export const SERVICE_AUTH_TTL_SECONDS = 60;

const ServiceAuthPayloadSchema = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
  lxm: Schema.optional(Schema.String),
});

export type ServiceAuthPayload = Schema.Schema.Type<
  typeof ServiceAuthPayloadSchema
>;

export const serviceAuthToken = (request: ServiceAuthRequest) =>
  Effect.gen(function* () {
    const issued = Math.floor(request.now / 1000);
    const payload: ServiceAuthPayload = {
      iss: request.iss,
      aud: request.aud,
      iat: issued,
      exp: issued + (request.lifetimeSeconds ?? SERVICE_AUTH_TTL_SECONDS),
      // Absent rather than null when it is not asked for: a claim that is not there is not a claim
      // a reader has to decide what to do with.
      ...(request.lxm === undefined ? {} : { lxm: request.lxm }),
    };
    return yield* signPayload(request.key, payload);
  });

/**
 * Read a service-auth token back, with the key **the caller supplies**.
 *
 * The key never comes from the token: a verifier takes it from the issuer's DID document, which is
 * the whole point of the format — so this takes it as an argument, checks the signature, checks
 * that the token was addressed to this service, and hands back the claims. A wrong key, another
 * audience, an expired token: all are `InvalidToken` rather than a claim worth reading.
 */
export const verifyServiceAuth = (request: {
  readonly key: ProofKey;
  readonly token: string;
  readonly audience: string;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const [header, body, signature] = request.token.split('.');
    if (header === undefined || body === undefined || signature === undefined) {
      return yield* Effect.fail(new InvalidToken({ reason: 'not a token' }));
    }
    // The header names the curve, and the curve is checked rather than the bytes: a source we do not
    // control writes the same claim in its own field order, and comparing encodings refused the very
    // proofs a move arrives with.
    const algorithm = request.key.curve === 'p256' ? 'ES256' : 'ES256K';
    const named = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          alg: Schema.String,
          typ: Schema.optional(Schema.String),
        }),
      ),
    )(decoder.decode(base64urlDecode(header)));
    if (
      Option.isNone(named) ||
      named.value.alg !== algorithm ||
      (named.value.typ !== undefined && named.value.typ !== 'JWT')
    ) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'not a token we issue' }),
      );
    }
    const signed = utf8(`${header}.${body}`);
    const bytes = base64urlDecode(signature);
    const genuine = yield* request.key.curve === 'p256'
      ? verify(request.key.key, signed, bytes)
      : verifySecp256k1({
          didKey: request.key.didKey,
          data: signed,
          signature: bytes,
        });
    if (!genuine) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'the signature does not verify' }),
      );
    }
    const decoded = Schema.decodeUnknownOption(
      Schema.fromJsonString(ServiceAuthPayloadSchema),
    )(decoder.decode(base64urlDecode(body)));
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'the payload does not parse' }),
      );
    }
    const payload = decoded.value;
    if (payload.aud !== request.audience) {
      return yield* Effect.fail(
        new InvalidToken({ reason: 'not for this service' }),
      );
    }
    if (payload.exp <= Math.floor(request.now / 1000)) {
      return yield* Effect.fail(new InvalidToken({ reason: 'expired' }));
    }
    return payload;
  });
