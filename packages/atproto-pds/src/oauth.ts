import { Effect, Option, Schema } from 'effect';
import {
  type PublicKey,
  base64urlDecode,
  base64urlEncode,
  importPublicKey,
  sha256,
  verify,
} from '@eoa/crypto';

/**
 * OAuth at the resource server (the Effect-PDS map, `27un`).
 *
 * The PDS does not issue these tokens — an authorization server does, and the
 * PDS is told which one to trust. What it owes is the **checking**, and there
 * are two tokens in every request:
 *
 * - the **access token**, an `at+jwt` from the issuer, naming the account
 *   (`sub`), the audience (`aud`, which must be this PDS) and the key the token
 *   is bound to (`cnf.jkt`);
 * - the **DPoP proof**, a `dpop+jwt` the client signs with that key, binding the
 *   proof to *this* request (`htm`, `htu`), to *this* moment (`iat`) and to
 *   *this* token (`ath`).
 *
 * The check that makes DPoP worth having is the join between them: the
 * thumbprint of the key that signed the proof must be the thumbprint the token
 * was issued to. A stolen access token is then useless without the private key,
 * and a stolen proof is useless on any other request.
 *
 * `alg` is never read from either token: this build verifies ES256, and a token
 * that says otherwise is refused rather than talked into verifying an HMAC with
 * a public key as the secret.
 */

/** The one algorithm this build verifies. */
const ALGORITHM = 'ES256';

/** How far a proof's `iat` may be from now, in seconds. */
const PROOF_WINDOW_SECONDS = 300;

/** How far ahead of now a token's `iat` may be, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

/** Reported when a token or a proof is not one we can accept. */
export class OAuthError extends Schema.TaggedError<OAuthError>()('OAuthError', {
  message: Schema.String,
}) {}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const failed = (message: string) => new OAuthError({ message });

/** A key failure is an OAuth failure from the caller's point of view. */
const fromCrypto = (cause: { readonly message: string }) =>
  failed(cause.message);

/**
 * A public EC JWK, as a proof header or an operator's config carries it. `d` is
 * declared only so a proof that embeds a private key can be **refused** rather
 * than have it quietly dropped: a client that leaks its key here has leaked it.
 */
const PublicJwkSchema = Schema.Struct({
  // `kty` and `crv` are compared explicitly below rather than pinned here, so a
  // key of another kind gets a specific refusal instead of a schema error.
  kty: Schema.String,
  crv: Schema.String,
  x: Schema.String,
  y: Schema.String,
  d: Schema.optionalKey(Schema.String),
  kid: Schema.optionalKey(Schema.String),
});

export type PublicJwk = Schema.Schema.Type<typeof PublicJwkSchema>;

/**
 * The canonical form RFC 7638 hashes: exactly these members, in exactly this
 * (lexicographic) order. The order *is* the canonicalisation — reorder the
 * struct and every thumbprint silently changes — so a test writes the JSON out
 * by hand and pins the result.
 */
const ThumbprintSchema = Schema.Struct({
  crv: Schema.Literal('P-256'),
  kty: Schema.Literal('EC'),
  x: Schema.String,
  y: Schema.String,
});

const encodeThumbprint = Schema.encodeEffect(
  Schema.fromJsonString(ThumbprintSchema),
);

/** A JWK as an operator configures it — already an object, not JSON text. */
const decodeJwk = Schema.decodeUnknownOption(PublicJwkSchema);

/** `base64url(SHA-256(canonical jwk))` — what a token's `cnf.jkt` holds. */
export const jwkThumbprint = (jwk: {
  readonly x: string;
  readonly y: string;
}) =>
  Effect.gen(function* () {
    const canonical = yield* encodeThumbprint({
      crv: 'P-256',
      kty: 'EC',
      x: jwk.x,
      y: jwk.y,
    }).pipe(
      Effect.mapError((cause) =>
        failed(`cannot canonicalise the key: ${String(cause)}`),
      ),
    );
    const digest = yield* sha256(encoder.encode(canonical)).pipe(
      Effect.mapError(fromCrypto),
    );
    return base64urlEncode(digest);
  });

/** `base64url(SHA-256(ASCII(access token)))` — the `ath` claim. */
export const accessTokenHash = (accessToken: string) =>
  sha256(encoder.encode(accessToken)).pipe(
    Effect.map(base64urlEncode),
    Effect.mapError(fromCrypto),
  );

/** The three segments of a compact JWS, or nothing. */
const split = (token: string) => {
  const parts = token.split('.');
  const header = parts[0];
  const body = parts[1];
  const signature = parts[2];
  return parts.length === 3 &&
    header !== undefined &&
    body !== undefined &&
    signature !== undefined
    ? Option.some({ header, body, signature })
    : Option.none<{ header: string; body: string; signature: string }>();
};

/** Verify a signature with the given key, over the first two segments. */
const signatureHolds = (params: {
  readonly key: PublicKey;
  readonly parts: {
    readonly header: string;
    readonly body: string;
    readonly signature: string;
  };
}) =>
  verify(
    params.key,
    encoder.encode(`${params.parts.header}.${params.parts.body}`),
    base64urlDecode(params.parts.signature),
  ).pipe(
    Effect.mapError(fromCrypto),
    Effect.flatMap((genuine) =>
      genuine
        ? Effect.succeed(true)
        : Effect.fail(failed('the signature does not verify')),
    ),
  );

/** DPoP binds `htu` to the request URI without query or fragment (RFC 9449 §4.3). */
const bareUrl = (url: string) => {
  if (!URL.canParse(url)) {
    return url;
  }
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

const DpopHeaderSchema = Schema.Struct({
  typ: Schema.Literal('dpop+jwt'),
  alg: Schema.String,
  jwk: PublicJwkSchema,
});

const DpopPayloadSchema = Schema.Struct({
  jti: Schema.String,
  htm: Schema.String,
  htu: Schema.String,
  iat: Schema.Finite,
  ath: Schema.optionalKey(Schema.String),
});

const decodeDpopHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(DpopHeaderSchema),
);
const decodeDpopPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(DpopPayloadSchema),
);

/** A proof that checked out: the key it was made with, and its one-use id. */
export interface VerifiedProof {
  readonly jkt: string;
  readonly jti: string;
  readonly iat: number;
}

/**
 * Verify a proof, and that it binds to the request being made.
 *
 * Every check is required: the signature against the key **in the proof** (which
 * is what makes DPoP self-enrolling), the pinned algorithm, `htm`/`htu`,
 * freshness, and `ath` against the token it travelled with.
 */
export const verifyProof = (params: {
  readonly proof: string;
  readonly htm: string;
  readonly htu: string;
  readonly accessToken: string;
  /** seconds since the epoch; passed in so the check is testable */
  readonly now: number;
  readonly windowSeconds?: number;
}) =>
  Effect.gen(function* () {
    const parts = split(params.proof);
    if (Option.isNone(parts)) {
      return yield* Effect.fail(failed('a proof is three base64url segments'));
    }
    const header = decodeDpopHeader(
      decoder.decode(base64urlDecode(parts.value.header)),
    );
    if (Option.isNone(header)) {
      return yield* Effect.fail(
        failed('the proof header is not a DPoP JWS header'),
      );
    }
    if (header.value.alg !== ALGORITHM) {
      return yield* Effect.fail(
        failed(
          `this build verifies ${ALGORITHM} only; the proof says ${header.value.alg}`,
        ),
      );
    }
    if (header.value.jwk.d !== undefined) {
      return yield* Effect.fail(failed('the proof embeds a private key'));
    }
    if (header.value.jwk.kty !== 'EC' || header.value.jwk.crv !== 'P-256') {
      return yield* Effect.fail(failed('the proof key is not an EC P-256 key'));
    }

    const key = yield* importPublicKey({
      kty: header.value.jwk.kty,
      crv: header.value.jwk.crv,
      x: header.value.jwk.x,
      y: header.value.jwk.y,
    }).pipe(Effect.mapError(fromCrypto));
    yield* signatureHolds({ key, parts: parts.value });

    const payload = decodeDpopPayload(
      decoder.decode(base64urlDecode(parts.value.body)),
    );
    if (Option.isNone(payload)) {
      return yield* Effect.fail(
        failed('the proof payload is not a DPoP claim'),
      );
    }

    if (payload.value.htm.toUpperCase() !== params.htm.toUpperCase()) {
      return yield* Effect.fail(
        failed(`the proof is for ${payload.value.htm}, not ${params.htm}`),
      );
    }
    if (bareUrl(payload.value.htu) !== bareUrl(params.htu)) {
      return yield* Effect.fail(
        failed(`the proof is for ${payload.value.htu}, not ${params.htu}`),
      );
    }
    if (
      Math.abs(params.now - payload.value.iat) >
      (params.windowSeconds ?? PROOF_WINDOW_SECONDS)
    ) {
      return yield* Effect.fail(failed('the proof is not fresh'));
    }

    const expected = yield* accessTokenHash(params.accessToken);
    if (payload.value.ath !== expected) {
      return yield* Effect.fail(
        failed('the proof is not bound to this access token'),
      );
    }

    return {
      jkt: yield* jwkThumbprint({
        x: header.value.jwk.x,
        y: header.value.jwk.y,
      }),
      jti: payload.value.jti,
      iat: payload.value.iat,
    };
  });

const AccessTokenHeaderSchema = Schema.Struct({
  typ: Schema.Literal('at+jwt'),
  alg: Schema.String,
  kid: Schema.optionalKey(Schema.String),
});

const AccessTokenPayloadSchema = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  iat: Schema.Finite,
  scope: Schema.optionalKey(Schema.String),
  cnf: Schema.Struct({ jkt: Schema.String }),
});

const decodeAccessHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(AccessTokenHeaderSchema),
);
const decodeAccessPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(AccessTokenPayloadSchema),
);

/** What an access token says, once it is known to be genuine. */
export interface OAuthClaims {
  readonly did: string;
  /** The key the token is bound to; a proof must be made with it. */
  readonly jkt: string;
  readonly scope: ReadonlyArray<string>;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

/**
 * Verify an access token: its signature with the issuer's key, and every claim
 * that makes it usable *here* — the issuer we trust, an audience that is this
 * PDS, and a moment that has not passed.
 */
export const verifyAccessToken = (params: {
  readonly token: string;
  readonly issuer: string;
  readonly audience: string;
  readonly key: PublicKey;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const parts = split(params.token);
    if (Option.isNone(parts)) {
      return yield* Effect.fail(failed('a token is three base64url segments'));
    }
    const header = decodeAccessHeader(
      decoder.decode(base64urlDecode(parts.value.header)),
    );
    if (Option.isNone(header)) {
      return yield* Effect.fail(
        failed('the token header is not an at+jwt header'),
      );
    }
    if (header.value.alg !== ALGORITHM) {
      return yield* Effect.fail(
        failed(
          `this build verifies ${ALGORITHM} only; the token says ${header.value.alg}`,
        ),
      );
    }
    yield* signatureHolds({ key: params.key, parts: parts.value });

    const payload = decodeAccessPayload(
      decoder.decode(base64urlDecode(parts.value.body)),
    );
    if (Option.isNone(payload)) {
      return yield* Effect.fail(
        failed('the token payload is not an access token claim'),
      );
    }

    if (payload.value.iss !== params.issuer) {
      return yield* Effect.fail(
        failed(`the token is from ${payload.value.iss}, not ${params.issuer}`),
      );
    }
    const audiences = Array.isArray(payload.value.aud)
      ? payload.value.aud
      : [payload.value.aud];
    if (!audiences.includes(params.audience)) {
      return yield* Effect.fail(failed('the token is not for this server'));
    }
    if (payload.value.exp <= params.now) {
      return yield* Effect.fail(failed('the token has expired'));
    }
    if (payload.value.iat > params.now + CLOCK_SKEW_SECONDS) {
      return yield* Effect.fail(failed('the token was issued in the future'));
    }

    return {
      did: payload.value.sub,
      jkt: payload.value.cnf.jkt,
      scope: (payload.value.scope ?? '')
        .split(' ')
        .filter((one) => one.length > 0),
      expiresAt: payload.value.exp,
    };
  });

/** A JWK an operator configures, read as the key we verify the issuer with. */
export const issuerKey = (jwk: PublicJwk) => {
  const decoded = decodeJwk(jwk);
  if (Option.isNone(decoded)) {
    return Effect.fail(failed('the configured issuer key is not a public JWK'));
  }
  if (decoded.value.kty !== 'EC' || decoded.value.crv !== 'P-256') {
    return Effect.fail(
      failed('the configured issuer key is not an EC P-256 key'),
    );
  }
  return importPublicKey({
    kty: decoded.value.kty,
    crv: decoded.value.crv,
    x: decoded.value.x,
    y: decoded.value.y,
  }).pipe(Effect.mapError(fromCrypto));
};
