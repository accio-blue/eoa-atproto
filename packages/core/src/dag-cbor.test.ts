import {
  CborDecodeError,
  CborEncodeError,
  type CborValue,
  CidLink,
  decodeCbor,
  encodeCbor,
} from './dag-cbor.js';
import { describe, expect, it } from 'vitest';
import { Result } from 'effect';
import { encodeBase32 } from './multibase.js';
import { parseCid } from './cid.js';

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const bytesOfHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));

describe('dag-cbor encoding', () => {
  // Cross-checked byte-for-byte against @ipld/dag-cbor (the IPLD reference
  // encoder); the canonical form is what every `prev` link and DID hashes.
  const vectors: ReadonlyArray<readonly [string, CborValue, string]> = [
    ['null', null, 'f6'],
    ['booleans', [false, true], '82f4f5'],
    ['empty map', {}, 'a0'],
    ['empty array', [], '80'],
    ['empty string', '', '60'],
    [
      'integers at every header width',
      [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296],
      '8a000117181818ff19010019ffff1a000100001affffffff1b0000000100000000',
    ],
    ['negative integers', [-1, -24, -25, -256, -257], '852037381838ff390100'],
    ['largest safe integer', [Number.MAX_SAFE_INTEGER], '811b001fffffffffffff'],
    ['bytes', new Uint8Array([0, 1, 255]), '430001ff'],
    [
      'nested maps and arrays',
      { a: [1, { b: null }], c: 'x' },
      'a261618201a16162f661636178',
    ],
    [
      'keys ordered by length then bytes',
      { b: 1, aa: 2, a: 3, aaa: 4 },
      'a4616103616201626161026361616104',
    ],
    // 'é' is one UTF-16 unit but two UTF-8 bytes, so a JS-length sort would put
    // it first; canonical order compares UTF-8 byte length (both two) and then
    // the bytes, so 'ab' wins.
    ['utf-8 key length, not utf-16', { é: 1, ab: 2 }, 'a26261620262c3a901'],
    [
      'utf-8 byte lengths drive the order',
      { zé: 1, abcd: 2, ab: 3 },
      'a362616203637ac3a901646162636402',
    ],
    [
      'utf-8 values',
      { kéy: 'välue', ascii: 'ü' },
      'a2646bc3a9796676c3a46c756565617363696962c3bc',
    ],
  ];

  it.each(vectors)('encodes %s', (_name, value, expected) => {
    expect(hexOf(encodeCbor(value))).toBe(expected);
  });

  it('rejects undefined rather than dropping the key', () => {
    expect(() => encodeCbor({ sig: undefined })).toThrow(CborEncodeError);
  });

  it('rejects non-integers, which atproto does not allow', () => {
    expect(() => encodeCbor(1.5)).toThrow(CborEncodeError);
    expect(() => encodeCbor(Number.NaN)).toThrow(CborEncodeError);
    expect(() => encodeCbor(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      CborEncodeError,
    );
  });
});

describe('did:plc operation bytes', () => {
  // A full operation of the shape M1 mints, and the CID + DID derived from it.
  // This is the end-to-end path: encode -> hash -> identifier.
  const operation = {
    type: 'plc_operation',
    rotationKeys: ['did:key:zDnaeh9v2RmcMo13Du2d6pjUf5bZwtauYxj3n9dYjw4EZUAR7'],
    verificationMethods: {
      atproto: 'did:key:zDnaeh9v2RmcMo13Du2d6pjUf5bZwtauYxj3n9dYjw4EZUAR7',
    },
    alsoKnownAs: ['at://alice.test'],
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: 'https://example.test',
      },
    },
    prev: null,
  };

  const expectedHex =
    'a66470726576f664747970656d706c635f6f7065726174696f6e687365727669636573a16b617470726f746f5f706473a264747970657819417470726f746f506572736f6e616c4461746153657276657268656e64706f696e747468747470733a2f2f6578616d706c652e746573746b616c736f4b6e6f776e4173816f61743a2f2f616c6963652e746573746c726f746174696f6e4b6579738178396469643a6b65793a7a446e616568397632526d634d6f31334475326436706a556635625a7774617559786a336e3964596a7734455a5541523773766572696669636174696f6e4d6574686f6473a167617470726f746f78396469643a6b65793a7a446e616568397632526d634d6f31334475326436706a556635625a7774617559786a336e3964596a7734455a55415237';

  it('matches the reference encoding', () => {
    expect(hexOf(encodeCbor(operation))).toBe(expectedHex);
  });

  it('derives the CID and the did:plc identifier', async () => {
    const bytes = encodeCbor(operation);
    const digest = await sha256(bytes);

    expect(hexOf(digest)).toBe(
      '2d98c324707d6f95994ea6458c37dbb7e9096a9eb44a72318bb0b4dc0ce60eaa',
    );

    // CIDv1, dag-cbor (0x71), sha2-256 (0x12), 32-byte digest.
    const cidBytes = Uint8Array.from([0x01, 0x71, 0x12, 0x20, ...digest]);
    expect(`b${encodeBase32(cidBytes)}`).toBe(
      'bafyreibntdbsi4d5n6kzstvgiwgdpw5x5eewvhvujjzddc5qwtoazzqovi',
    );

    // The DID takes the first 15 bytes of the digest, which is exactly 24
    // base32 characters. (multiformats' base32 includes the `b` multibase
    // prefix, so its output has one character more than the identifier.)
    expect(`did:plc:${encodeBase32(digest).slice(0, 24)}`).toBe(
      'did:plc:fwmmgjdqpvxzlgkouzcyyn63',
    );
  });
});

describe('dag-cbor CID links and decoding', () => {
  const link = new CidLink({
    cid: Result.getOrThrow(
      parseCid('bafyreiblcw5xjipi44j5unnd3lnamlfxu6jay5pp42dl534omgwzgrny4y'),
    ),
  });

  it('encodes a CID link as tag 42 over the CID bytes behind a zero byte', () => {
    const bytes = encodeCbor(link);
    // 0xd8 0x2a = tag 42, 0x58 0x25 = a 37-byte string, then a zero prefix
    // and the CID itself: version 1, dag-cbor, sha2-256, 32 bytes.
    expect(hexOf(bytes).slice(0, 8)).toBe('d82a5825');
    expect(Array.from(bytes.slice(4, 9))).toEqual([
      0x00, 0x01, 0x71, 0x12, 0x20,
    ]);
    expect(bytes).toHaveLength(41);
  });

  it('round-trips a link through the decoder', () => {
    const decoded = decodeCbor(encodeCbor(link));
    expect(decoded).toBeInstanceOf(CidLink);
    expect(decoded).toEqual(link);
  });

  it('round-trips a nested structure', () => {
    const value = {
      e: [{ p: 0, k: 'a/b', v: link, t: null }],
      l: null,
    } satisfies CborValue;

    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it('re-encodes a decoded value to the same bytes, which is the canonical check', () => {
    const value = { a: [1, -2, 'three', null, true, link] } satisfies CborValue;
    const bytes = encodeCbor(value);

    expect(encodeCbor(decodeCbor(bytes))).toEqual(bytes);
  });

  it('rejects what the encoder cannot produce', () => {
    // 0xfb = a 64-bit float, 0x9f = an indefinite-length array,
    // 0xd9 0x00 0x00 = tag 0, 0x81 0x00 0x00 = an array with a trailing byte.
    const rejected = ['fb3ff0000000000000', '9fff', 'd90000', '8100' + '00'];
    for (const hex of rejected) {
      expect(() => decodeCbor(bytesOfHex(hex))).toThrow(CborDecodeError);
    }
  });
});
