import {
  type CryptoError,
  type PrivateKey,
  base64urlEncode,
  exportPublicKey,
  importPublicKey,
  sha256,
} from '@eoa/crypto';
import { Effect, Schema } from 'effect';
import {
  JWT_ALGORITHM,
  JwtError,
  segmentFor,
  signJwt,
  splitJwt,
  valueFrom,
  verifyJwtSignature,
} from './jwt.js';

/**
 * DPoP (RFC 9449) proofs.
 *
 * A proof is an ES256 JWT the client signs with a key it generates for itself —
 * no registration, no shared secret. Its header carries the public half, so the
 * server can verify the signature, and its payload binds that proof to *one*
 * request: `htm` (method), `htu` (URI), `iat` (freshness), `jti` (uniqueness),
 * `ath` (the access token it travels with) and `nonce` (once challenged).
 *
 * Two things make DPoP worth more than a bearer token, and both are checks a
 * server has to actually perform:
 *
 * - the proof is bound to the request, so a proof captured in transit cannot be
 *   replayed onto a different endpoint or method;
 * - the key is confirmed in the issued token (`cnf.jkt`, the RFC 7638 thumbprint
 *   this module returns as `jkt`), so a stolen access token is useless without
 *   the private key that made the proof.
 *
 * The `jti`/nonce *replay policy* is not here: that is state, and the state
 * machine deciding it is `dpop-nonce.ts` (spec-derived). This module's job ends
 * at "this proof is internally valid and bound to this request", and it hands the
 * jti on.
 */

const TEXT_ENCODER = new TextEncoder();

/** Reported when a proof is not one we can accept. */
export class DpopError extends Schema.TaggedError<DpopError>()('DpopError', {
  message: Schema.String,
}) {}

/** A JWT failure is a DPoP failure from the caller's point of view. */
const fromJwt = (cause: JwtError): DpopError =>
  new DpopError({ message: cause.message });

const fromCrypto = (cause: CryptoError): DpopError =>
  new DpopError({ message: cause.message });

/**
 * The `jwk` a proof carries. `d` is declared only so a proof which embeds a
 * private key can be **rejected** rather than have it silently dropped: a client
 * that leaks its key here has leaked it, and we should say so rather than accept
 * a proof that is valid but unsafe.
 */
const DpopJwkSchema = Schema.Struct({
  kty: Schema.Literal('EC'),
  crv: Schema.Literal('P-256'),
  x: Schema.String,
  y: Schema.String,
  d: Schema.optionalKey(Schema.String),
});

const DpopHeaderSchema = Schema.Struct({
  typ: Schema.Literal('dpop+jwt'),
  // compared explicitly below, so a wrong algorithm gets a specific message
  // instead of a schema error
  alg: Schema.String,
  jwk: DpopJwkSchema,
});

const DpopPayloadSchema = Schema.Struct({
  jti: Schema.String,
  htm: Schema.String,
  htu: Schema.String,
  iat: Schema.Finite,
  nonce: Schema.optionalKey(Schema.String),
  ath: Schema.optionalKey(Schema.String),
});

/** The four members a public EC JWK is made of. */
const PublicJwkSchema = Schema.Struct({
  kty: Schema.String,
  crv: Schema.String,
  x: Schema.String,
  y: Schema.String,
});

/**
 * The canonical form RFC 7638 hashes. The members are declared in the order the
 * RFC fixes (lexicographic), because that order *is* the canonicalisation: if
 * this struct is reordered the thumbprint silently changes, and the test that
 * pins it against a hand-written literal is what catches that.
 */
const ThumbprintSchema = Schema.Struct({
  crv: Schema.Literal('P-256'),
  kty: Schema.Literal('EC'),
  x: Schema.String,
  y: Schema.String,
});

/** The current time as JWT counts it. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A unique proof id. */
const newJti = (): string =>
  base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

/** DPoP binds `htu` to the request URI without query or fragment (RFC 9449 §4.3). */
const bareUrl = (url: string): string => {
  if (!URL.canParse(url)) {
    // not a URL we can parse; compare it as given rather than pretend it matched
    return url;
  }
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

/**
 * The key-confirmation value: the RFC 7638 thumbprint, over exactly the required
 * members in lexicographic order. It is what a token's `cnf.jkt` holds, so it
 * must be computed this way and no other.
 */
export const jwkThumbprint = (jwk: {
  readonly x: string;
  readonly y: string;
}): Effect.Effect<string, DpopError> =>
  Effect.gen(function* () {
    const canonical = yield* Schema.encodeEffect(
      Schema.fromJsonString(ThumbprintSchema),
    )({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y }).pipe(
      Effect.mapError(
        (cause) =>
          new DpopError({
            message: `cannot canonicalise the key: ${String(cause)}`,
          }),
      ),
    );
    return yield* sha256(TEXT_ENCODER.encode(canonical)).pipe(
      Effect.map(base64urlEncode),
      Effect.mapError(fromCrypto),
    );
  });

/** The public half of a key pair, as a proof header carries it. */
const publicJwkOf = (key: PrivateKey) =>
  Effect.gen(function* () {
    const exported = yield* exportPublicKey(key.publicKey).pipe(
      Effect.mapError(fromCrypto),
    );
    return yield* Effect.fromOption(
      Schema.decodeUnknownOption(PublicJwkSchema)(exported),
      () =>
        new DpopError({ message: 'the exported key is not an EC public JWK' }),
    );
  });

/**
 * The thumbprint of a key pair's public half: exactly what a token's `cnf.jkt`
 * holds, and what a client puts in a PAR's `dpop_jkt` to bind the request to the
 * key it will present the proof with.
 */
export const dpopKeyThumbprint = (
  key: PrivateKey,
): Effect.Effect<string, DpopError> =>
  Effect.gen(function* () {
    const jwk = yield* publicJwkOf(key);
    return yield* jwkThumbprint({ x: jwk.x, y: jwk.y });
  });

/** `base64url(SHA-256(ASCII(access token)))` — the `ath` claim. */
export const accessTokenHash = (
  accessToken: string,
): Effect.Effect<string, DpopError> =>
  sha256(TEXT_ENCODER.encode(accessToken)).pipe(
    Effect.map(base64urlEncode),
    Effect.mapError(fromCrypto),
  );

/**
 * Make a proof for one request. `accessToken` is required when the proof will be
 * presented *with* a token (a resource request) and omitted when it will not (a
 * token request).
 */
export const createProof = (params: {
  readonly key: PrivateKey;
  readonly htm: string;
  readonly htu: string;
  readonly accessToken?: string;
  readonly nonce?: string;
  readonly jti?: string;
  readonly iat?: number;
}) =>
  Effect.gen(function* () {
    const jwk = yield* publicJwkOf(params.key);

    const ath =
      params.accessToken === undefined
        ? undefined
        : yield* accessTokenHash(params.accessToken);

    const headerSegment = segmentFor({
      codec: Schema.fromJsonString(DpopHeaderSchema),
      value: {
        typ: 'dpop+jwt',
        alg: JWT_ALGORITHM,
        jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      },
    });
    const payloadSegment = segmentFor({
      codec: Schema.fromJsonString(DpopPayloadSchema),
      value: {
        jti: params.jti ?? newJti(),
        htm: params.htm.toUpperCase(),
        htu: params.htu,
        iat: params.iat ?? nowSeconds(),
        ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
        ...(ath === undefined ? {} : { ath }),
      },
    });

    return yield* signJwt({
      headerSegment,
      payloadSegment,
      key: params.key,
    }).pipe(Effect.mapError(fromJwt));
  });

/**
 * Verify a proof, and that it binds to the request being made.
 *
 * Every check is required: the signature against the key *in the proof*, the
 * algorithm, `htm`/`htu`, freshness, and `ath` when a token is present. Returns
 * the key thumbprint (for the token's `cnf.jkt`) and the jti, which the caller
 * folds through `dpop-nonce.ts` to catch replays.
 */
export const verifyProof = (params: {
  readonly proof: string;
  readonly htm: string;
  readonly htu: string;
  /** seconds since the epoch; passed in so the check is testable */
  readonly now: number;
  /** the nonce the server last issued, once it has challenged */
  readonly expectedNonce?: string;
  /** when presented with an access token, that token */
  readonly accessToken?: string;
  /** how far off `iat` may be, in seconds */
  readonly windowSeconds?: number;
}) =>
  Effect.gen(function* () {
    const { header: headerSegment, body } = yield* splitJwt(params.proof).pipe(
      Effect.mapError(fromJwt),
    );

    const header = yield* valueFrom({
      schema: DpopHeaderSchema,
      segment: headerSegment,
      message: 'the proof header is not a DPoP JWS header',
    }).pipe(Effect.mapError(fromJwt));
    if (header.alg !== JWT_ALGORITHM) {
      // loud and specific: a silently rejected algorithm looks like a broken
      // signature, and silently accepting one would be worse
      return yield* new DpopError({
        message: `this build verifies ${JWT_ALGORITHM} only; the proof says ${header.alg}`,
      });
    }
    if (header.jwk.d !== undefined) {
      return yield* new DpopError({
        message: 'the proof embeds a private key',
      });
    }

    const key = yield* importPublicKey({
      kty: header.jwk.kty,
      crv: header.jwk.crv,
      x: header.jwk.x,
      y: header.jwk.y,
    }).pipe(Effect.mapError(fromCrypto));
    yield* verifyJwtSignature({ token: params.proof, key }).pipe(
      Effect.mapError(fromJwt),
    );

    const payload = yield* valueFrom({
      schema: DpopPayloadSchema,
      segment: body,
      message: 'the proof payload is not a DPoP claim',
    }).pipe(Effect.mapError(fromJwt));

    if (payload.htm.toUpperCase() !== params.htm.toUpperCase()) {
      return yield* new DpopError({
        message: `the proof is for ${payload.htm}, not ${params.htm}`,
      });
    }
    if (bareUrl(payload.htu) !== bareUrl(params.htu)) {
      return yield* new DpopError({
        message: `the proof is for ${payload.htu}, not ${params.htu}`,
      });
    }

    const window = params.windowSeconds ?? 300;
    if (Math.abs(params.now - payload.iat) > window) {
      return yield* new DpopError({ message: 'the proof is not fresh' });
    }

    if (
      params.expectedNonce !== undefined &&
      payload.nonce !== params.expectedNonce
    ) {
      return yield* new DpopError({
        message: 'the proof does not carry the current nonce',
      });
    }

    if (params.accessToken !== undefined) {
      const expected = yield* accessTokenHash(params.accessToken);
      if (payload.ath !== expected) {
        return yield* new DpopError({
          message: 'the proof is not bound to this access token',
        });
      }
    }

    return {
      jkt: yield* jwkThumbprint({ x: header.jwk.x, y: header.jwk.y }),
      jti: payload.jti,
      nonce: payload.nonce,
      iat: payload.iat,
    };
  });
