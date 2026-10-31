/**
 * BigInt <-> big-endian byte conversions.
 *
 * One copy on purpose: the multibase codecs, the CID layer and the P-256 scalar
 * arithmetic all need this conversion, and a second copy is a second chance to
 * get the padding wrong.
 */

const BYTE_BITS = 8n;
const BYTE_MASK = 0xffn;
const BYTE_BITS_NUMBER = 8;
const BIT_RADIX = 2;

/** Reads big-endian bytes as an unsigned integer. */
export const bigIntOfBytes = (bytes: Uint8Array) =>
  bytes.reduce(
    (accumulator, byte) => (accumulator << BYTE_BITS) | BigInt(byte),
    0n,
  );

/**
 * Writes an unsigned integer as `bitLength / 8` big-endian bytes, left-padded
 * with zeros. Pass `bitLength` rather than a byte count so callers state the
 * width of the field the value belongs to (256 for a P-256 coordinate, 32 for
 * a digest) and the padding cannot drift.
 */
export const bytesOfBigInt = (params: { value: bigint; bitLength: number }) => {
  const byteCount = Math.floor(params.bitLength / BYTE_BITS_NUMBER);
  return Uint8Array.from({ length: byteCount }, (_unused, index) =>
    Number(
      (params.value >>
        BigInt(params.bitLength - (index + 1) * BYTE_BITS_NUMBER)) &
        BYTE_MASK,
    ),
  );
};

/** The number of bytes needed to represent an unsigned integer. */
export const bigIntByteLength = (value: bigint) =>
  value === 0n
    ? 0
    : Math.ceil(value.toString(BIT_RADIX).length / BYTE_BITS_NUMBER);
