import { Effect, Result } from 'effect';
import {
  P256_ORDER,
  compressPoint,
  formatP256DidKey,
  isSignatureNormalized,
  normalizeSignature,
  parseP256DidKey,
  uncompressPoint,
} from './p256.js';
import { bigIntOfBytes, bytesOfBigInt } from '@eoa/core';
import { createDIDKey, extractPublicKeyFromDID, verifyDIDKey } from './did.js';
import { describe, expect, it } from 'vitest';
import { sign, verify } from './signing.js';
import { generateES256KeyPair } from './keys.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

/** The high-S twin of a signature: same `r`, `s` reflected about the order. */
const highSVariant = (signature: Uint8Array) =>
  Uint8Array.from([
    ...signature.slice(0, 32),
    ...bytesOfBigInt({
      value: P256_ORDER - bigIntOfBytes(signature.slice(32)),
      bitLength: 256,
    }),
  ]);

// A real did:key from the did:plc specification.
const REAL_DID_KEY =
  'did:key:zDnaeh9v2RmcMo13Du2d6pjUf5bZwtauYxj3n9dYjw4EZUAR7';

describe('low-S canonicalisation', () => {
  it('signs in low-S form, which then verifies', async () => {
    const keyPair = await Effect.runPromise(generateES256KeyPair());
    const signature = await Effect.runPromise(
      sign(keyPair.privateKey, utf8('hello')),
    );

    expect(isSignatureNormalized(signature)).toBe(true);
    expect(
      await Effect.runPromise(
        verify(keyPair.publicKey, utf8('hello'), signature),
      ),
    ).toBe(true);
  });

  it('maps the high-S twin back to the low-S signature', async () => {
    const keyPair = await Effect.runPromise(generateES256KeyPair());
    const signature = await Effect.runPromise(
      sign(keyPair.privateKey, utf8('hello')),
    );
    const highS = highSVariant(signature);

    expect(isSignatureNormalized(highS)).toBe(false);
    expect(normalizeSignature(highS)).toEqual(signature);
  });

  it('rejects the high-S twin even though WebCrypto would accept it', async () => {
    const keyPair = await Effect.runPromise(generateES256KeyPair());
    const signature = await Effect.runPromise(
      sign(keyPair.privateKey, utf8('hello')),
    );

    expect(
      await Effect.runPromise(
        verify(keyPair.publicKey, utf8('hello'), highSVariant(signature)),
      ),
    ).toBe(false);
  });
});

describe('P-256 did:key', () => {
  it('decodes a real did:key and re-encodes it unchanged', () => {
    const compressed = Result.getOrThrow(parseP256DidKey(REAL_DID_KEY));
    const uncompressed = uncompressPoint(compressed);

    expect(compressed).toHaveLength(33);
    expect(uncompressed).toHaveLength(65);
    expect(uncompressed.at(0)).toBe(0x04);
    // A wrong square root or a dropped sign bit would change the did:key here.
    expect(compressPoint(uncompressed)).toEqual(compressed);
    expect(formatP256DidKey(compressed)).toBe(REAL_DID_KEY);
  });

  it('round-trips a generated key through WebCrypto', async () => {
    const keyPair = await Effect.runPromise(generateES256KeyPair());
    const did = await Effect.runPromise(createDIDKey(keyPair.publicKey));

    expect(did.startsWith('did:key:z')).toBe(true);

    const extracted = await Effect.runPromise(extractPublicKeyFromDID(did));
    expect(await Effect.runPromise(verifyDIDKey(did, extracted))).toBe(true);

    const signature = await Effect.runPromise(
      sign(keyPair.privateKey, utf8('round trip')),
    );
    expect(
      await Effect.runPromise(verify(extracted, utf8('round trip'), signature)),
    ).toBe(true);
  });

  it('rejects a did:key that is not P-256', () => {
    // An ed25519 did:key (multicodec 0xed01) is a valid did:key, just not ours.
    const ed25519 = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    expect(Result.isFailure(parseP256DidKey(ed25519))).toBe(true);
    expect(Result.isFailure(parseP256DidKey('did:web:example.test'))).toBe(
      true,
    );
  });

  it('rejects a compressed point that is not on the curve', () => {
    // x = 1 has no square root for y on P-256, so this cannot be a point.
    const offCurve = Uint8Array.from([
      0x02,
      ...bytesOfBigInt({ value: 1n, bitLength: 256 }),
    ]);
    expect(() => uncompressPoint(offCurve)).toThrow();
  });
});
