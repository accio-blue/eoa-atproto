import { DID } from '@eoa/core';
import { Effect } from 'effect';

export { DID };

// Key types for AT Protocol
export interface PrivateKey {
  readonly type: 'private';
  readonly algorithm: 'ES256' | 'ES256K';
  readonly key: CryptoKey;
  readonly publicKey: PublicKey;
}

export interface PublicKey {
  readonly type: 'public';
  readonly algorithm: 'ES256' | 'ES256K';
  readonly key: CryptoKey;
  readonly did?: DID;
}

// Key pair interface
export interface KeyPair {
  readonly privateKey: PrivateKey;
  readonly publicKey: PublicKey;
}

// Generate a new ES256 key pair
export const generateES256KeyPair = (): Effect.Effect<KeyPair, CryptoError> =>
  Effect.gen(function* () {
    try {
      const keyPair = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.generateKey(
            {
              name: 'ECDSA',
              namedCurve: 'P-256',
            },
            true, // extractable
            ['sign', 'verify'],
          ),
        catch: (error) =>
          new CryptoError({ cause: error, operation: 'keyGeneration' }),
      });

      const privateKey: PrivateKey = {
        type: 'private',
        algorithm: 'ES256',
        key: keyPair.privateKey,
        publicKey: {
          type: 'public',
          algorithm: 'ES256',
          key: keyPair.publicKey,
        },
      };

      const publicKey: PublicKey = {
        type: 'public',
        algorithm: 'ES256',
        key: keyPair.publicKey,
      };

      return { privateKey, publicKey };
    } catch (error) {
      return yield* Effect.fail(
        new CryptoError({ cause: error, operation: 'keyGeneration' }),
      );
    }
  });

// Generate a new ES256K (secp256k1) key pair
export const generateES256KKeyPair = (): Effect.Effect<KeyPair, CryptoError> =>
  Effect.gen(function* () {
    // Note: ES256K is not natively supported in Web Crypto API, and a secp256k1
    // key cannot be a `KeyPair` here - there is no `CryptoKey` to put it in.
    // What this build *can* do with the curve lives in `secp256k1.ts`
    // (`secp256k1KeyFromScalar`, `signSecp256k1`, `verifySecp256k1`).
    return yield* Effect.fail(
      new CryptoError({
        cause: new Error('ES256K not supported in Web Crypto API'),
        operation: 'keyGeneration',
      }),
    );
  });

// Export private key as JWK
export const exportPrivateKey = (
  privateKey: PrivateKey,
): Effect.Effect<JsonWebKey, CryptoError> =>
  Effect.tryPromise({
    try: () => crypto.subtle.exportKey('jwk', privateKey.key),
    catch: (error) => new CryptoError({ cause: error, operation: 'keyExport' }),
  });

// Export public key as JWK
export const exportPublicKey = (
  publicKey: PublicKey,
): Effect.Effect<JsonWebKey, CryptoError> =>
  Effect.tryPromise({
    try: () => crypto.subtle.exportKey('jwk', publicKey.key),
    catch: (error) => new CryptoError({ cause: error, operation: 'keyExport' }),
  });

/**
 * A private key from a JWK - P-256, the curve WebCrypto holds. secp256k1 does
 * not come through here even though the `algorithm` parameter names it: there is
 * no `CryptoKey` for that curve, so `importSecp256k1Key` (in `secp256k1.ts`)
 * reads one as a scalar instead.
 */
export const importPrivateKey = (
  jwk: JsonWebKey,
  algorithm: 'ES256' | 'ES256K' = 'ES256',
): Effect.Effect<PrivateKey, CryptoError> =>
  Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          'jwk',
          jwk,
          {
            name: 'ECDSA',
            namedCurve: algorithm === 'ES256' ? 'P-256' : 'secp256k1',
          },
          true,
          ['sign'],
        ),
      catch: (error) =>
        new CryptoError({ cause: error, operation: 'keyImport' }),
    });

    const publicKeyJwk = { ...jwk };
    delete publicKeyJwk.d; // Remove private key component

    const publicKey = yield* importPublicKey(publicKeyJwk, algorithm);

    return {
      type: 'private' as const,
      algorithm,
      key,
      publicKey,
    };
  });

// Import public key from JWK
export const importPublicKey = (
  jwk: JsonWebKey,
  algorithm: 'ES256' | 'ES256K' = 'ES256',
): Effect.Effect<PublicKey, CryptoError> =>
  Effect.gen(function* () {
    // Chromium enforces a JWK's `key_ops` against the usages of the import call
    // ("the JWK usage must be a superset of those requested"); Node's WebCrypto
    // ignores it. A public JWK derived from a private export still carries
    // `key_ops: ['sign']` (see `importPrivateKey`), so the derived key must state
    // the usage being asked for rather than inherit the private key's.
    const verificationJwk: JsonWebKey = { ...jwk, key_ops: ['verify'] };

    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          'jwk',
          verificationJwk,
          {
            name: 'ECDSA',
            namedCurve: algorithm === 'ES256' ? 'P-256' : 'secp256k1',
          },
          true,
          ['verify'],
        ),
      catch: (error) =>
        new CryptoError({ cause: error, operation: 'keyImport' }),
    });

    return {
      type: 'public' as const,
      algorithm,
      key,
    };
  });

// Import an uncompressed SEC1 P-256 point as a verification key
export const importP256PublicKeyFromPoint = (point: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        'raw',
        Uint8Array.from(point),
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify'],
      ),
    catch: (cause) => new CryptoError({ cause, operation: 'keyImport' }),
  }).pipe(
    Effect.map((key) => ({
      type: 'public' as const,
      algorithm: 'ES256' as const,
      key,
    })),
  );

// Crypto error type
export class CryptoError extends Error {
  readonly _tag = 'CryptoError';

  constructor(
    readonly options: {
      readonly cause: unknown;
      readonly operation: string;
    },
  ) {
    super(`Crypto operation '${options.operation}' failed: ${options.cause}`);
  }
}
