import {
  CODEC_DAG_CBOR,
  CidError,
  cidFromDigest,
  formatCid,
  parseCid,
} from './cid.js';
import { describe, expect, it } from 'vitest';
import { Result } from 'effect';
import { encodeBase32 } from './multibase.js';

const bytesOfHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const cidStringOf = (bytes: ReadonlyArray<number>) =>
  `b${encodeBase32(Uint8Array.from(bytes))}`;

// sha256 of the plc_operation encoded in dag-cbor.test.ts, and the CID that
// @ipld/dag-cbor + multiformats derive from it.
const OP_DIGEST_HEX =
  '2d98c324707d6f95994ea6458c37dbb7e9096a9eb44a72318bb0b4dc0ce60eaa';
const OP_CID = 'bafyreibntdbsi4d5n6kzstvgiwgdpw5x5eewvhvujjzddc5qwtoazzqovi';

describe('cid', () => {
  it('formats the CID of an operation digest', () => {
    const cid = cidFromDigest({
      codec: CODEC_DAG_CBOR,
      digest: bytesOfHex(OP_DIGEST_HEX),
    });

    expect(formatCid(cid)).toBe(OP_CID);
  });

  it('parses a CID back to its parts', () => {
    const parsed = Result.getOrThrow(parseCid(OP_CID));

    expect(parsed.version).toBe(1);
    expect(parsed.codec).toBe(CODEC_DAG_CBOR);
    expect(parsed.digest).toEqual(bytesOfHex(OP_DIGEST_HEX));
    expect(formatCid(parsed)).toBe(OP_CID);
  });

  it('round-trips a raw-codec CID', () => {
    const digest = bytesOfHex('00'.repeat(31) + 'ff');
    const text = formatCid(cidFromDigest({ codec: 0x55, digest }));

    expect(Result.getOrThrow(parseCid(text))).toEqual({
      version: 1,
      codec: 0x55,
      digest,
    });
  });

  it('rejects a non-base32 multibase prefix', () => {
    expect(Result.isFailure(parseCid('zDnaeh9v2RmcMo13Du2d6pjUf5bZ'))).toBe(
      true,
    );
  });

  it('rejects invalid base32', () => {
    expect(Result.isFailure(parseCid('bMZXW6'))).toBe(true);
  });

  it('rejects an unsupported CID version', () => {
    const bytes = [
      0x02,
      CODEC_DAG_CBOR,
      0x12,
      0x20,
      ...bytesOfHex(OP_DIGEST_HEX),
    ];
    expect(Result.isFailure(parseCid(cidStringOf(bytes)))).toBe(true);
  });

  it('rejects a multi-byte codec varint', () => {
    const bytes = [0x01, 0x80, 0x12, 0x20, ...bytesOfHex(OP_DIGEST_HEX)];
    expect(Result.isFailure(parseCid(cidStringOf(bytes)))).toBe(true);
  });

  it('rejects an unsupported multihash code', () => {
    const bytes = [
      0x01,
      CODEC_DAG_CBOR,
      0x13,
      0x20,
      ...bytesOfHex(OP_DIGEST_HEX),
    ];
    expect(Result.isFailure(parseCid(cidStringOf(bytes)))).toBe(true);
  });

  it('rejects a digest whose length contradicts its header', () => {
    const short = bytesOfHex(OP_DIGEST_HEX).slice(0, 31);
    const bytes = [0x01, CODEC_DAG_CBOR, 0x12, 0x20, ...short];
    expect(Result.isFailure(parseCid(cidStringOf(bytes)))).toBe(true);
  });

  it('rejects a truncated header', () => {
    expect(
      Result.isFailure(parseCid(cidStringOf([0x01, CODEC_DAG_CBOR]))),
    ).toBe(true);
  });

  it('reports failures as a CidError', () => {
    const result = parseCid('nope');
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(CidError);
  });
});
