import { BASE58BTC_PREFIX, decodeBase58Btc, encodeBase58Btc } from '@eoa/core';
import { Effect, Result } from 'effect';
import { CryptoError } from './keys.js';
import { base64urlDecode } from './signing.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/**
 * secp256k1 `did:key`s: the curve every `did:plc` made elsewhere lists, and the
 * one WebCrypto does not have.
 *
 * WebCrypto is where P-256 lives; secp256k1 comes from `@noble/curves`, so this
 * module *does* sign and verify - it is not only reading shapes. Three hands it
 * matters for: a server relaying an operation it did not sign to the directory
 * (refusing a valid one for its curve is the bug this prevents), the directory
 * **checking** that operation, and the operator's own offline recovery key,
 * which is secp256k1 on every account made elsewhere - so undoing a switch
 * needs it too.
 *
 * The low-S rule is `did:plc`'s and goes both ways: noble signs low-S and
 * `verify` refuses the high-S twin, which is what stops a signature being
 * rewritten without changing the operation's CID.
 */

/** multicodec `0xe7` (secp256k1-pub), varint-encoded as `e7 01`. */
const SECP256K1_MULTICODEC = Uint8Array.from([0xe7, 0x01]);

/** A compressed point: the `x` coordinate, and `y`'s parity in the prefix byte. */
const COMPRESSED_POINT_BYTES = 33;

/** The prefix byte's two legal values: `y` even, or `y` odd. */
const EVEN_PARITY = 0x02;
const ODD_PARITY = 0x03;

const invalid = (message: string) =>
  new CryptoError({ cause: new Error(message), operation: 'secp256k1' });

/** Reads the compressed point out of a secp256k1 `did:key`. */
export const parseSecp256k1DidKey = (did: string) => {
  if (!did.startsWith('did:key:')) {
    return Result.fail(invalid('expected a did:key identifier'));
  }

  const multibase = did.slice('did:key:'.length);
  if (!multibase.startsWith(BASE58BTC_PREFIX)) {
    return Result.fail(invalid('expected a base58btc did:key'));
  }

  const decoded = decodeBase58Btc(multibase.slice(BASE58BTC_PREFIX.length));
  if (Result.isFailure(decoded)) {
    return Result.fail(invalid(decoded.failure.message));
  }

  const bytes = decoded.success;
  const prefix = bytes.subarray(0, SECP256K1_MULTICODEC.length);
  if (
    bytes.length !== SECP256K1_MULTICODEC.length + COMPRESSED_POINT_BYTES ||
    prefix.at(0) !== SECP256K1_MULTICODEC.at(0) ||
    prefix.at(1) !== SECP256K1_MULTICODEC.at(1)
  ) {
    return Result.fail(
      invalid('expected a secp256k1 did:key (multicodec 0xe7)'),
    );
  }

  const point = bytes.subarray(SECP256K1_MULTICODEC.length);
  const parity = point.at(0);
  if (parity !== EVEN_PARITY && parity !== ODD_PARITY) {
    return Result.fail(invalid('expected a compressed point (0x02 or 0x03)'));
  }

  return Result.succeed(point);
};

/** Builds the `did:key` for a secp256k1 compressed point. */
export const formatSecp256k1DidKey = (point: Uint8Array) => {
  if (point.length !== COMPRESSED_POINT_BYTES) {
    throw invalid('expected a compressed point to format a did:key');
  }
  return `did:key:${BASE58BTC_PREFIX}${encodeBase58Btc(
    Uint8Array.from([...SECP256K1_MULTICODEC, ...point]),
  )}`;
};

/**
 * A secp256k1 key, in one piece.
 *
 * There is no `CryptoKey` to split in two, because WebCrypto cannot hold this
 * curve: a key is its 32-byte scalar plus the 33-byte point that scalar derives
 * to, and the `did:key` the point is written as - a rotation list names that,
 * not the point.
 */
export interface Secp256k1Key {
  readonly type: 'secp256k1';
  /** The scalar that signs. */
  readonly scalar: Uint8Array;
  /** The compressed public point, 33 bytes. */
  readonly point: Uint8Array;
  /** `did:key:zQ3s…` - the point as a rotation list names it. */
  readonly didKey: string;
}

/** Derives a key - the point and its `did:key` included - from its scalar. */
export const secp256k1KeyFromScalar = (
  scalar: Uint8Array,
): Effect.Effect<Secp256k1Key, CryptoError> =>
  Effect.try({
    try: () => {
      if (!secp256k1.utils.isValidSecretKey(scalar)) {
        throw new Error('not a secp256k1 scalar');
      }
      const point = secp256k1.getPublicKey(scalar, true);
      return {
        type: 'secp256k1' as const,
        scalar,
        point,
        didKey: formatSecp256k1DidKey(point),
      };
    },
    catch: (cause) => new CryptoError({ cause, operation: 'keyImport' }),
  });

/**
 * Reads the private half out of a JWK. Only `d` is read, never `x`/`y`: the point
 * is derived from the scalar, so a JWK whose public half belongs to some other
 * key cannot sign as the key it claims to be.
 */
export const importSecp256k1Key = (
  jwk: JsonWebKey,
): Effect.Effect<Secp256k1Key, CryptoError> =>
  Effect.gen(function* () {
    if (jwk.crv !== 'secp256k1') {
      return yield* Effect.fail(
        invalid(`expected a secp256k1 JWK, got crv=${String(jwk.crv)}`),
      );
    }
    if (jwk.d === undefined) {
      return yield* Effect.fail(
        invalid('the JWK carries no private half (`d`)'),
      );
    }
    return yield* secp256k1KeyFromScalar(base64urlDecode(jwk.d));
  });

/**
 * Signs bytes the way `did:plc` requires: `sha256` over them, raw `r||s`, low-S.
 *
 * noble hashes the message itself (its `prehash` default) and normalises to
 * low-S - the same two rules the WebCrypto path enforces by hand in
 * `normalizeSignature`, because the high-S twin would give the operation a
 * second CID.
 */
export const signSecp256k1 = (params: {
  readonly key: Secp256k1Key;
  readonly data: Uint8Array;
}): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => secp256k1.sign(params.data, params.key.scalar, { lowS: true }),
    catch: (cause) => new CryptoError({ cause, operation: 'signing' }),
  });

/** Verifies a signature against a secp256k1 `did:key`, low-S included. */
export const verifySecp256k1 = (params: {
  readonly didKey: string;
  readonly data: Uint8Array;
  readonly signature: Uint8Array;
}): Effect.Effect<boolean, CryptoError> =>
  Effect.gen(function* () {
    const parsed = parseSecp256k1DidKey(params.didKey);
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(parsed.failure);
    }

    return yield* Effect.try({
      try: () => {
        // A point that is not on the curve cannot have signed anything, and the
        // answer to that is **no**: the key was never going to verify, which is
        // not the same as the directory being unable to check a signature.
        if (!secp256k1.utils.isValidPublicKey(parsed.success, true)) {
          return false;
        }
        return secp256k1.verify(params.signature, params.data, parsed.success, {
          lowS: true,
        });
      },
      catch: (cause) => new CryptoError({ cause, operation: 'verification' }),
    });
  });
