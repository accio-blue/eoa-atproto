import {
  BASE32_PREFIX,
  BASE58BTC_PREFIX,
  MultibaseError,
  decodeBase32,
  decodeBase58Btc,
  encodeBase32,
  encodeBase58Btc,
} from './multibase.js';
import { describe, expect, it } from 'vitest';
import { Result } from 'effect';

const bytesFromText = (text: string) => new TextEncoder().encode(text);

const decodeOrThrow = (result: Result.Result<Uint8Array, MultibaseError>) =>
  Result.getOrThrow(result);

describe('base32 (RFC 4648, unpadded, lowercase)', () => {
  // Vectors straight from RFC 4648 section 10, lowercased and de-padded.
  const rfcVectors: ReadonlyArray<readonly [string, string]> = [
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foob', 'mzxw6yq'],
    ['fooba', 'mzxw6ytb'],
    ['foobar', 'mzxw6ytboi'],
  ];

  it.each(rfcVectors)('encodes %s as %s', (text, encoded) => {
    expect(encodeBase32(bytesFromText(text))).toBe(encoded);
    expect(decodeOrThrow(decodeBase32(encoded))).toEqual(bytesFromText(text));
  });

  it('matches the multibase form of a CID hash', () => {
    // sha256("hello"); cross-checked against the multiformats base32 codec.
    const digest = Uint8Array.from(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'.match(
        /../g,
      ) ?? [],
      (byte) => Number.parseInt(byte, 16),
    );

    expect(BASE32_PREFIX + encodeBase32(digest)).toBe(
      'bftze3os7wcrq4jxihmvmlopctynrmhs4d6tuexttaqzwfe4ltasa',
    );
  });

  it('rejects non-zero trailing bits', () => {
    // 'mz' carries 10 bits: one byte plus two padding bits that must be zero.
    expect(Result.isFailure(decodeBase32('mz'))).toBe(true);
  });

  it('rejects an input that ends mid-character', () => {
    expect(Result.isFailure(decodeBase32('m'))).toBe(true);
  });

  it('rejects uppercase, which is a different multibase encoding', () => {
    expect(Result.isFailure(decodeBase32('MZXW6'))).toBe(true);
  });

  it('round-trips every length from 0 to 40 bytes', () => {
    const lengths = Array.from({ length: 41 }, (_unused, index) => index);
    for (const length of lengths) {
      const bytes = Uint8Array.from({ length }, (_unused, index) => index * 7);
      expect(decodeOrThrow(decodeBase32(encodeBase32(bytes)))).toEqual(bytes);
    }
  });
});

describe('base58btc', () => {
  // Bitcoin's reference vectors, plus the leading-zero cases.
  const base58Vectors: ReadonlyArray<readonly [string, string]> = [
    ['', ''],
    ['\u0000', '1'],
    ['\u0000\u0000\u0001', '112'],
    ['Hello World!', '2NEpo7TZRRrLZSi2U'],
  ];

  it.each(base58Vectors)('encodes %j as %s', (text, encoded) => {
    expect(encodeBase58Btc(bytesFromText(text))).toBe(encoded);
    expect(decodeOrThrow(decodeBase58Btc(encoded))).toEqual(
      bytesFromText(text),
    );
  });

  it('round-trips a hash160 address payload', () => {
    const hex = '00010966776006953D5567439E5E39F86A0D273BEE';
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    );

    // The raw hash160, leading zero byte included. The well-known
    // `16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM` string is this payload with a version
    // byte and a checksum appended, so it is not a vector for the bare
    // encoding. Cross-checked against the multiformats base58btc codec.
    expect(encodeBase58Btc(bytes)).toBe('1qb3y62fmEEVTPySXPQ77WXok6H');
    expect(decodeOrThrow(decodeBase58Btc(encodeBase58Btc(bytes)))).toEqual(
      bytes,
    );
  });

  it('decodes a real did:key public key', () => {
    const multibase = 'zDnaeh9v2RmcMo13Du2d6pjUf5bZwtauYxj3n9dYjw4EZUAR7';
    const decoded = decodeOrThrow(decodeBase58Btc(multibase.slice(1)));

    // 0x1200 (varint p256-pub) followed by a 33-byte compressed point.
    expect(decoded).toHaveLength(35);
    expect([decoded[0], decoded[1]]).toEqual([0x80, 0x24]);
    expect(BASE58BTC_PREFIX + encodeBase58Btc(decoded)).toBe(multibase);
  });

  it('rejects characters outside the alphabet', () => {
    // '0', 'O' and 'I' are excluded so the alphabet is unambiguous.
    for (const invalid of ['0', 'O', 'I']) {
      expect(Result.isFailure(decodeBase58Btc(invalid))).toBe(true);
    }
  });
});
