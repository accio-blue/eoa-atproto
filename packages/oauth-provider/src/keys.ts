import { Context, Effect, Layer, Schema } from 'effect';
import {
  type KeyPair,
  type PrivateKey,
  exportPublicKey,
  generateES256KeyPair,
} from '@eoa/crypto';
import { dpopKeyThumbprint } from '@eoa/oauth';

/**
 * The provider's token-signing key.
 *
 * An access token is signed, and a resource server verifies it without asking us —
 * that is the whole point of a signed token. So this key is the provider's root of
 * trust, and the `kid` every token header carries is its thumbprint, which makes it
 * stable, unique, and derivable without a registry.
 *
 * Key *custody* is deliberately not decided here: this module takes a key pair and
 * publishes the public half. Where the private half lives and how it rotates is the
 * deployment's business, the same way the PDS's commit-signing key already is.
 */

/** Reported when the provider's keys cannot be prepared. */
export class TokenKeysError extends Schema.TaggedError<TokenKeysError>()(
  'TokenKeysError',
  { message: Schema.String },
) {}

/** A public key, as a JWKS document carries it. */
export interface PublicJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: 'ES256';
  readonly use: 'sig';
}

/** The document `/.well-known/jwks.json` serves. */
export interface Jwks {
  readonly keys: ReadonlyArray<PublicJwk>;
}

/** The signing key, its id, and the public document. */
export interface TokenKeysShape {
  readonly privateKey: PrivateKey;
  readonly kid: string;
  readonly jwks: Jwks;
}

/** The provider's keys, as a service, so a deployment supplies them once. */
export class TokenKeys extends Context.Service<TokenKeys, TokenKeysShape>()(
  'oauth-provider/TokenKeys',
) {}

const PublicJwkSchema = Schema.Struct({
  kty: Schema.String,
  crv: Schema.String,
  x: Schema.String,
  y: Schema.String,
});

/** Prepare the keys a provider runs with. */
export const makeTokenKeys = (params: {
  readonly keyPair: KeyPair;
}): Effect.Effect<TokenKeysShape, TokenKeysError> =>
  Effect.gen(function* () {
    const kid = yield* dpopKeyThumbprint(params.keyPair.privateKey).pipe(
      Effect.mapError(
        (cause) => new TokenKeysError({ message: cause.message }),
      ),
    );
    const exported = yield* exportPublicKey(params.keyPair.publicKey).pipe(
      Effect.mapError(
        (cause) => new TokenKeysError({ message: cause.message }),
      ),
    );
    const jwk = yield* Effect.fromOption(
      Schema.decodeUnknownOption(PublicJwkSchema)(exported),
      () =>
        new TokenKeysError({
          message: 'the exported key is not an EC public JWK',
        }),
    );

    return {
      privateKey: params.keyPair.privateKey,
      kid,
      jwks: {
        keys: [
          {
            kty: jwk.kty,
            crv: jwk.crv,
            x: jwk.x,
            y: jwk.y,
            kid,
            alg: 'ES256',
            use: 'sig',
          },
        ],
      },
    };
  });

/** Prepare the keys a provider runs with, generating them. */
export const generateTokenKeys: Effect.Effect<TokenKeysShape, TokenKeysError> =
  Effect.gen(function* () {
    const keyPair = yield* generateES256KeyPair().pipe(
      Effect.mapError(
        (cause) => new TokenKeysError({ message: cause.message }),
      ),
    );
    return yield* makeTokenKeys({ keyPair });
  });

/** A provider's keys, as a Layer. */
export const tokenKeysLayer = (shape: TokenKeysShape): Layer.Layer<TokenKeys> =>
  Layer.succeed(TokenKeys, shape);
