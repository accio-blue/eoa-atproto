import { Effect, Schema } from 'effect';
import {
  type PrivateKey,
  type PublicKey,
  base64urlDecode,
  base64urlEncode,
  sign,
  verify,
} from '@eoa/crypto';

/**
 * The ES256 JWT, as this package needs it: a DPoP proof today, and an access
 * token from M3 on. Three base64url segments and one signature over the first
 * two.
 *
 * `alg` is **pinned**, never read from the header. That pinning is the whole
 * reason this is a module rather than four lines inline: `alg` is
 * attacker-supplied, and an implementation that trusts it can be talked into
 * checking an HMAC with a public key as the secret.
 *
 * Segments are built and read through the schema that describes them — never
 * through the global `JSON` API — so a header or payload that is not the shape
 * the caller means fails here rather than three checks later.
 *
 * ponytail: this is the same JWT `packages/atproto-pds/src/token.ts` builds for service
 * auth, minus the payload schema. It is duplicated deliberately here — the
 * *client* must not depend on the server, and `@eoa/crypto` (the layer
 * both could share) has no schema-parameterised codec yet. Unify the two when
 * service auth is next touched; that is when the shared home becomes obvious and
 * the change is cheap.
 */

/** The one algorithm this build signs and verifies. */
export const JWT_ALGORITHM = 'ES256';

/** Reported when a token is not one we can accept. */
export class JwtError extends Schema.TaggedError<JwtError>()('JwtError', {
  message: Schema.String,
}) {}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** A JSON document as text, for the one step between bytes and a schema. */
const JsonText = Schema.fromJsonString(Schema.Unknown);

/** The three segments of a compact JWS, or the reason they are not. */
export const splitJwt = (token: string) =>
  Effect.gen(function* () {
    const [header, body, signature, ...rest] = token.split('.');
    if (
      header === undefined ||
      body === undefined ||
      signature === undefined ||
      rest.length > 0
    ) {
      return yield* new JwtError({
        message: 'a JWT is three base64url segments',
      });
    }
    return { header, body, signature };
  });

/** Serialize a schema-typed value into one base64url JWS segment. */
export const segmentFor = <A>(params: {
  readonly codec: Schema.Codec<A, string, never, never>;
  readonly value: A;
}): string =>
  base64urlEncode(
    TEXT_ENCODER.encode(Schema.encodeSync(params.codec)(params.value)),
  );

/** Read one base64url JWS segment through the schema that describes it. */
export const valueFrom = <S extends Schema.ConstraintDecoder<unknown>>(params: {
  readonly schema: S;
  readonly segment: string;
  readonly message: string;
}): Effect.Effect<S['Type'], JwtError> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => TEXT_DECODER.decode(base64urlDecode(params.segment)),
      catch: (cause) =>
        new JwtError({
          message: `segment is not base64url: ${String(cause)}`,
        }),
    });
    const json = yield* Effect.fromOption(
      Schema.decodeOption(JsonText)(text),
      () => new JwtError({ message: 'a JWT segment is JSON' }),
    );
    return yield* Effect.fromOption(
      Schema.decodeUnknownOption(params.schema)(json),
      () => new JwtError({ message: params.message }),
    );
  });

/** Sign two prepared segments. */
export const signJwt = (params: {
  readonly headerSegment: string;
  readonly payloadSegment: string;
  readonly key: PrivateKey;
}) =>
  Effect.gen(function* () {
    const signed = `${params.headerSegment}.${params.payloadSegment}`;
    const signature = yield* sign(params.key, TEXT_ENCODER.encode(signed)).pipe(
      Effect.mapError(
        (cause) =>
          new JwtError({ message: `signing failed: ${String(cause)}` }),
      ),
    );
    return `${signed}.${base64urlEncode(signature)}`;
  });

/** Verify the signature over the exact bytes that arrived. */
export const verifyJwtSignature = (params: {
  readonly token: string;
  readonly key: PublicKey;
}) =>
  Effect.gen(function* () {
    const { header, body, signature } = yield* splitJwt(params.token);
    const signatureBytes = yield* Effect.try({
      try: () => base64urlDecode(signature),
      catch: (cause) =>
        new JwtError({
          message: `signature is not base64url: ${String(cause)}`,
        }),
    });

    const signed = yield* verify(
      params.key,
      TEXT_ENCODER.encode(`${header}.${body}`),
      signatureBytes,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new JwtError({ message: `verification failed: ${String(cause)}` }),
      ),
    );
    if (!signed) {
      return yield* new JwtError({
        message: 'the signature does not match the key',
      });
    }
  });
