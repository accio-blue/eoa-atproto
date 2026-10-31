import { CryptoError, PrivateKey, PublicKey } from './keys.js';
import { isSignatureNormalized, normalizeSignature } from './p256.js';
import { Effect } from 'effect';

// Sign data with a private key
export const sign = (
  privateKey: PrivateKey,
  data: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.gen(function* () {
    try {
      const signature = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.sign(
            {
              name: 'ECDSA',
              hash: { name: 'SHA-256' },
            },
            privateKey.key,
            data as BufferSource,
          ),
        catch: (error) =>
          new CryptoError({ cause: error, operation: 'signing' }),
      });

      // ECDSA offers two valid signatures per message; did:plc accepts only the
      // low-S one, and a high-S signature would give the operation a second CID.
      return normalizeSignature(new Uint8Array(signature));
    } catch (error) {
      return yield* Effect.fail(
        new CryptoError({ cause: error, operation: 'signing' }),
      );
    }
  });

// Verify signature with a public key
export const verify = (
  publicKey: PublicKey,
  data: Uint8Array,
  signature: Uint8Array,
): Effect.Effect<boolean, CryptoError> =>
  Effect.gen(function* () {
    // WebCrypto accepts both halves of the pair, so the low-S rule is ours to
    // enforce: accepting the high-S twin would let a signature be rewritten
    // without invalidating it.
    if (!isSignatureNormalized(signature)) {
      return false;
    }

    try {
      const isValid = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.verify(
            {
              name: 'ECDSA',
              hash: { name: 'SHA-256' },
            },
            publicKey.key,
            signature as BufferSource,
            data as BufferSource,
          ),
        catch: (error) =>
          new CryptoError({ cause: error, operation: 'verification' }),
      });

      return isValid;
    } catch (error) {
      return yield* Effect.fail(
        new CryptoError({ cause: error, operation: 'verification' }),
      );
    }
  });

// Hash data using SHA-256
export const sha256 = (
  data: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.tryPromise({
    try: async () => {
      const hash = await crypto.subtle.digest('SHA-256', data as BufferSource);
      return new Uint8Array(hash);
    },
    catch: (error) => new CryptoError({ cause: error, operation: 'hashing' }),
  });

// Generate a random 32-byte key for HMAC
export const generateRandomKey = (): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.getRandomValues(new Uint8Array(32));
      return key;
    },
    catch: (error) =>
      new CryptoError({ cause: error, operation: 'randomKeyGeneration' }),
  });

/**
 * HKDF-SHA256, extract then expand (RFC 5869), the derivation RFC 9180's DHKEM
 * builds its shared secret with.
 *
 * WebCrypto implements the whole thing, so the two steps are not written out
 * here: passing the salt and the info to `deriveBits` is the same computation.
 */
export const hkdfSha256 = (params: {
  readonly ikm: Uint8Array;
  readonly salt: Uint8Array;
  readonly info: Uint8Array;
  readonly length: number;
}): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          'raw',
          params.ikm as BufferSource,
          'HKDF',
          false,
          ['deriveBits'],
        ),
      catch: (error) =>
        new CryptoError({ cause: error, operation: 'hkdfKeyImport' }),
    });
    const bits = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: params.salt as BufferSource,
            info: params.info as BufferSource,
          },
          key,
          params.length * 8,
        ),
      catch: (error) => new CryptoError({ cause: error, operation: 'hkdf' }),
    });
    return new Uint8Array(bits);
  });

// HMAC-SHA256
export const hmacSha256 = (
  key: Uint8Array,
  data: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.gen(function* () {
    try {
      const cryptoKey = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            'raw',
            key as BufferSource,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          ),
        catch: (error) =>
          new CryptoError({ cause: error, operation: 'hmacKeyImport' }),
      });

      const signature = yield* Effect.tryPromise({
        try: () => crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource),
        catch: (error) =>
          new CryptoError({ cause: error, operation: 'hmacSigning' }),
      });

      return new Uint8Array(signature);
    } catch (error) {
      return yield* Effect.fail(
        new CryptoError({ cause: error, operation: 'hmac' }),
      );
    }
  });

// Base64url encode
export const base64urlEncode = (data: Uint8Array): string => {
  const base64 = btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

// Base64url decode
export const base64urlDecode = (str: string): Uint8Array => {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// Create a multibase-encoded multihash (simplified version)
export const createMultihash = (
  data: Uint8Array,
): Effect.Effect<string, CryptoError> =>
  Effect.gen(function* () {
    const hash = yield* sha256(data);
    // Simple base58btc encoding (placeholder - would need proper multibase implementation)
    const multihash = new Uint8Array([0x12, 0x20, ...hash]); // 0x12 = sha2-256, 0x20 = 32 bytes
    return `b${base64urlEncode(multihash)}`;
  });
