import {
  BASE58BTC_PREFIX,
  bigIntOfBytes,
  bytesOfBigInt,
  decodeBase58Btc,
  encodeBase58Btc,
} from '@eoa/core';
import { Effect, Result } from 'effect';
import { CryptoError } from './keys.js';
import { p256 } from '@noble/curves/nist.js';

/**
 * P-256 scalar and point arithmetic that the WebCrypto API does not expose.
 *
 * Two things live here because the platform will not do them:
 *
 * 1. **Low-S canonicalisation.** ECDSA has two valid signatures per message -
 *    `(r, s)` and `(r, n - s)`. WebCrypto produces either and accepts both, but
 *    `did:plc` requires the low-S form and rejects the high-S twin, because
 *    otherwise a signature could be rewritten without invalidating it and the
 *    operation's CID would change. So we normalise on the way out and enforce
 *    on the way in.
 *
 * 2. **Point compression.** A `did:key` carries the 33-byte compressed point
 *    (multicodec `0x1200` + `x` with the parity of `y` in the prefix byte),
 *    while WebCrypto imports and exports the 65-byte uncompressed SEC1 form.
 */

/** The order (n) of the P-256 group. Half of it is the low-S boundary. */
export const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const P256_PRIME =
  0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_CURVE_A = -3n;
const P256_CURVE_B =
  0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

const COORDINATE_BITS = 256;
const SCALAR_BYTES = 32;
const SIGNATURE_BYTES = 64;
const COMPRESSED_POINT_BYTES = 33;
const UNCOMPRESSED_POINT_BYTES = 65;
const COMPRESSED_EVEN = 0x02;
const COMPRESSED_ODD = 0x03;
const UNCOMPRESSED = 0x04;
const ODD = 1n;
const TWO = 2n;

/** p is 3 (mod 4), so a square root of a residue is `value ^ ((p + 1) / 4)`. */
const SQRT_EXPONENT = (P256_PRIME + 1n) / 4n;

/** did:key multicodec for a P-256 public key: the varint `0x1200`. */
const P256_MULTICODEC = Uint8Array.from([0x80, 0x24]);

const invalid = (message: string) =>
  new CryptoError({ cause: new Error(message), operation: 'p256' });

const signatureScalar = (signature: Uint8Array) =>
  bigIntOfBytes(signature.slice(SCALAR_BYTES));

/** True when `s` is in the lower half of the group order - the only form `did:plc` accepts. */
export const isSignatureNormalized = (signature: Uint8Array) =>
  signature.length === SIGNATURE_BYTES &&
  signatureScalar(signature) * TWO <= P256_ORDER;

/** Rewrites a high-S signature as its canonical low-S twin. */
export const normalizeSignature = (signature: Uint8Array) => {
  if (signature.length !== SIGNATURE_BYTES) {
    throw invalid(
      `expected a ${SIGNATURE_BYTES}-byte signature, got ${signature.length}`,
    );
  }

  const scalar = signatureScalar(signature);
  if (scalar * TWO <= P256_ORDER) {
    return signature;
  }

  return Uint8Array.from([
    ...signature.slice(0, SCALAR_BYTES),
    ...bytesOfBigInt({
      value: P256_ORDER - scalar,
      bitLength: COORDINATE_BITS,
    }),
  ]);
};

/** Compresses a 65-byte uncompressed SEC1 point to its 33-byte form. */
export const compressPoint = (point: Uint8Array) => {
  if (
    point.length !== UNCOMPRESSED_POINT_BYTES ||
    point.at(0) !== UNCOMPRESSED
  ) {
    throw invalid('expected an uncompressed SEC1 point');
  }

  const y = point.at(UNCOMPRESSED_POINT_BYTES - 1) ?? 0;
  return Uint8Array.from([
    y % 2 === 0 ? COMPRESSED_EVEN : COMPRESSED_ODD,
    ...point.slice(1, SCALAR_BYTES + 1),
  ]);
};

const modularPower = (params: {
  base: bigint;
  exponent: bigint;
  modulus: bigint;
}) =>
  // Square-and-multiply, most significant bit first, as a fold so no
  // intermediate state has to be reassigned.
  Array.from(params.exponent.toString(2)).reduce((accumulator, bit) => {
    const squared = (accumulator * accumulator) % params.modulus;
    return bit === '1' ? (squared * params.base) % params.modulus : squared;
  }, 1n);

/** Expands a 33-byte compressed point to the uncompressed SEC1 form WebCrypto imports. */
export const uncompressPoint = (point: Uint8Array) => {
  const prefix = point.at(0);
  if (
    point.length !== COMPRESSED_POINT_BYTES ||
    (prefix !== COMPRESSED_EVEN && prefix !== COMPRESSED_ODD)
  ) {
    throw invalid('expected a compressed SEC1 point');
  }

  const x = bigIntOfBytes(point.slice(1));
  const reduced = (x ** 3n + P256_CURVE_A * x + P256_CURVE_B) % P256_PRIME;
  const ySquared = reduced < 0n ? reduced + P256_PRIME : reduced;
  const root = modularPower({
    base: ySquared,
    exponent: SQRT_EXPONENT,
    modulus: P256_PRIME,
  });

  if ((root * root) % P256_PRIME !== ySquared) {
    throw invalid('compressed point is not on the P-256 curve');
  }

  const y =
    (root % TWO === ODD) === (prefix === COMPRESSED_ODD)
      ? root
      : P256_PRIME - root;

  return Uint8Array.from([
    UNCOMPRESSED,
    ...bytesOfBigInt({ value: x, bitLength: COORDINATE_BITS }),
    ...bytesOfBigInt({ value: y, bitLength: COORDINATE_BITS }),
  ]);
};

/** Builds the `did:key` for a P-256 compressed point. */
export const formatP256DidKey = (compressedPoint: Uint8Array) => {
  if (compressedPoint.length !== COMPRESSED_POINT_BYTES) {
    throw invalid('expected a compressed point to format a did:key');
  }
  return `did:key:${BASE58BTC_PREFIX}${encodeBase58Btc(
    Uint8Array.from([...P256_MULTICODEC, ...compressedPoint]),
  )}`;
};

/** Reads the compressed point out of a P-256 `did:key`. */
export const parseP256DidKey = (did: string) => {
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
  const prefix = bytes.subarray(0, P256_MULTICODEC.length);
  if (
    bytes.length !== P256_MULTICODEC.length + COMPRESSED_POINT_BYTES ||
    prefix.at(0) !== P256_MULTICODEC.at(0) ||
    prefix.at(1) !== P256_MULTICODEC.at(1)
  ) {
    return Result.fail(invalid('expected a P-256 did:key (multicodec 0x1200)'));
  }

  return Result.succeed(bytes.subarray(P256_MULTICODEC.length));
};

/** The uncompressed SEC1 point inside a `did:key`, ready for WebCrypto import. */
export const importablePointFromDidKey = (did: string) =>
  Effect.gen(function* () {
    const parsed = parseP256DidKey(did);
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(parsed.failure);
    }
    return yield* Effect.try({
      try: () => uncompressPoint(parsed.success),
      catch: (cause) => new CryptoError({ cause, operation: 'p256' }),
    });
  });

/** The `did:key` for a public key, from the `x`/`y` coordinates of its JWK. */
export const formatDidKeyFromCoordinates = (params: {
  readonly x: Uint8Array;
  readonly y: Uint8Array;
}) =>
  Effect.try({
    try: () =>
      formatP256DidKey(
        compressPoint(
          Uint8Array.from([UNCOMPRESSED, ...params.x, ...params.y]),
        ),
      ),
    catch: (cause) => new CryptoError({ cause, operation: 'p256' }),
  });

/** A fresh P-256 secret scalar: 32 bytes from a CSPRNG. */
export const generateP256SecretKey = (): Effect.Effect<
  Uint8Array,
  CryptoError
> =>
  Effect.try({
    try: () => p256.utils.randomSecretKey(),
    catch: (cause) => new CryptoError({ cause, operation: 'p256' }),
  });

/** The uncompressed SEC1 point (65 bytes) of a secret scalar. */
export const p256PublicPoint = (
  secretKey: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => p256.getPublicKey(secretKey, false),
    catch: (cause) => new CryptoError({ cause, operation: 'p256' }),
  });

/**
 * ECDH on P-256: the 32-byte x-coordinate of the shared point.
 *
 * The x-coordinate alone is what key derivation needs (RFC 9180's DHKEM keeps
 * exactly this much), so the y-coordinate never leaves this function.
 */
export const p256SharedSecret = (params: {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    // `true` asks noble for the compressed point, whose first byte is the parity
    // of y: dropping it leaves the x-coordinate, which is the shared secret.
    try: () =>
      p256.getSharedSecret(params.secretKey, params.publicKey, true).slice(1),
    catch: (cause) => new CryptoError({ cause, operation: 'p256' }),
  });
