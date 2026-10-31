import { Data, Result } from 'effect';
import {
  bigIntByteLength,
  bigIntOfBytes,
  bytesOfBigInt,
} from './bigint-bytes.js';

/**
 * Multibase alphabets for this network: RFC 4648 base32 (lowercase, unpadded -
 * the `b` multibase of CIDs and `did:plc` identifiers) and base58btc (the `z`
 * multibase of `did:key`).
 *
 * Both decoders are STRICT: trailing padding bits must be zero, so a byte
 * string has exactly one valid encoding. These strings feed hashes and
 * signatures, where a second encoding of the same bytes would be a second
 * identity.
 *
 * Inputs here are short (hashes, public keys, signatures), so both codecs work
 * on a whole-input BigInt rather than in streaming chunks.
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE58BTC_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58BTC_RADIX = 58n;
const BASE58BTC_ZERO_DIGIT = BASE58BTC_ALPHABET.charAt(0);
const ZERO_BYTE = 0;
const BYTE_BITS = 8;
const BASE32_CHAR_BITS = 5;
const BASE32_CHAR_MASK = 0b11111;
const BASE32_BYTES_PER_GROUP = 5;

/** Multibase prefixes: `b` for base32, `z` for base58btc. */
export const BASE32_PREFIX = 'b';
export const BASE58BTC_PREFIX = 'z';

/** Reported when a multibase string is not exactly one valid encoding. */
export class MultibaseError extends Data.TaggedError('MultibaseError')<{
  readonly message: string;
}> {}

const countLeading = (params: { text: string; digit: string }) => {
  const firstOther = Array.from(params.text).findIndex(
    (char) => char !== params.digit,
  );
  return firstOther < 0 ? params.text.length : firstOther;
};

const countLeadingZeroBytes = (bytes: Uint8Array) => {
  const firstNonZero = bytes.findIndex((byte) => byte !== ZERO_BYTE);
  return firstNonZero < 0 ? bytes.length : firstNonZero;
};

/**
 * RFC 4648 base32, unpadded and lowercase, without the `b` multibase prefix.
 *
 * Pads to whole 5-byte groups so every group is exactly 8 characters, then
 * truncates to the length the real input earns - the padding bits are zero, so
 * the truncated characters are exactly the ones base32 would emit.
 */
export const encodeBase32 = (bytes: Uint8Array) => {
  const paddedLength =
    Math.ceil(bytes.length / BASE32_BYTES_PER_GROUP) * BASE32_BYTES_PER_GROUP;
  const padded = Uint8Array.from(
    { length: paddedLength },
    (_unused, index) => bytes[index] ?? ZERO_BYTE,
  );
  const totalBits = paddedLength * BYTE_BITS;
  const value = bigIntOfBytes(padded);

  const groups = Array.from(
    { length: totalBits / BASE32_CHAR_BITS },
    (_unused, index) =>
      BASE32_ALPHABET.charAt(
        Number(
          (value >> BigInt(totalBits - (index + 1) * BASE32_CHAR_BITS)) &
            BigInt(BASE32_CHAR_MASK),
        ),
      ),
  ).join('');

  return groups.slice(
    0,
    Math.ceil((bytes.length * BYTE_BITS) / BASE32_CHAR_BITS),
  );
};

/** Decodes unpadded lowercase RFC 4648 base32, rejecting malleable input. */
export const decodeBase32 = (text: string) => {
  const values = Array.from(text, (char) => BASE32_ALPHABET.indexOf(char));
  const invalid = values.findIndex((value) => value < 0);
  if (invalid >= 0) {
    return Result.fail(
      new MultibaseError({
        message: `invalid base32 character '${text.charAt(invalid)}'`,
      }),
    );
  }

  const totalBits = values.length * BASE32_CHAR_BITS;
  const trailingBits = totalBits % BYTE_BITS;
  if (trailingBits >= BASE32_CHAR_BITS) {
    return Result.fail(
      new MultibaseError({ message: 'base32 input ends mid-character' }),
    );
  }

  const value = values.reduce(
    (accumulator, digit) =>
      (accumulator << BigInt(BASE32_CHAR_BITS)) | BigInt(digit),
    0n,
  );
  if (trailingBits > 0 && value % (1n << BigInt(trailingBits)) !== 0n) {
    return Result.fail(
      new MultibaseError({
        message: 'base32 input has non-zero trailing bits',
      }),
    );
  }

  return Result.succeed(bytesOfBigInt({ value, bitLength: totalBits }));
};

// Recursive, so TypeScript cannot infer the return type (TS7023); the
// annotation is required here, not stylistic.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
const base58Digits = (value: bigint): string =>
  value === 0n
    ? ''
    : base58Digits(value / BASE58BTC_RADIX) +
      BASE58BTC_ALPHABET.charAt(Number(value % BASE58BTC_RADIX));

/** base58btc without the `z` multibase prefix. */
export const encodeBase58Btc = (bytes: Uint8Array) =>
  BASE58BTC_ZERO_DIGIT.repeat(countLeadingZeroBytes(bytes)) +
  base58Digits(bigIntOfBytes(bytes));

/** Decodes base58btc, rejecting characters outside the alphabet. */
export const decodeBase58Btc = (text: string) => {
  const digits = Array.from(text, (char) => BASE58BTC_ALPHABET.indexOf(char));
  const invalid = digits.findIndex((digit) => digit < 0);
  if (invalid >= 0) {
    return Result.fail(
      new MultibaseError({
        message: `invalid base58btc character '${text.charAt(invalid)}'`,
      }),
    );
  }

  const value = digits.reduce(
    (accumulator, digit) => accumulator * BASE58BTC_RADIX + BigInt(digit),
    0n,
  );
  const zeroCount = countLeading({ text, digit: BASE58BTC_ZERO_DIGIT });
  const magnitude = bytesOfBigInt({
    value,
    bitLength: bigIntByteLength(value) * BYTE_BITS,
  });
  const bytes = new Uint8Array(zeroCount + magnitude.length);
  bytes.set(magnitude, zeroCount);

  return Result.succeed(bytes);
};
