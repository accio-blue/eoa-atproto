import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  importSecp256k1Key,
  parseSecp256k1DidKey,
  secp256k1KeyFromScalar,
  signSecp256k1,
  verifySecp256k1,
} from './secp256k1.js';
import { base64urlEncode } from './signing.js';
import { formatP256DidKey } from './p256.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/**
 * The fixture is kocharin's own rotation key, taken from its audit log: the
 * account this was written for, rather than a key made up to pass.
 */
const KOCHARIN_ROTATION_KEY =
  'did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg';

/** A scalar, fixed rather than random: the arithmetic is what is under test. */
const SCALAR = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const BYTES = new TextEncoder().encode('an operation, dag-cbor encoded');

describe('a secp256k1 did:key', () => {
  it('reads the compressed point', () => {
    const parsed = parseSecp256k1DidKey(KOCHARIN_ROTATION_KEY);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      throw new Error(parsed.failure.message);
    }
    expect(parsed.success.length).toBe(33);
    expect([0x02, 0x03]).toContain(parsed.success.at(0));
  });

  it('refuses another curve, and a key that is not one', () => {
    const other = formatP256DidKey(new Uint8Array(33).fill(1));
    expect(Result.isFailure(parseSecp256k1DidKey(other))).toBe(true);
    expect(Result.isFailure(parseSecp256k1DidKey('did:key:zNotAKey'))).toBe(
      true,
    );
    expect(Result.isFailure(parseSecp256k1DidKey('did:web:example.com'))).toBe(
      true,
    );
  });
});

describe('signing with secp256k1', () => {
  it('derives the point, and a did:key that reads back to it', async () => {
    const key = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    const parsed = parseSecp256k1DidKey(key.didKey);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      throw new Error(parsed.failure.message);
    }
    expect(parsed.success).toEqual(key.point);
    expect(key.point.length).toBe(33);
  });

  it('signs low-S in 64 bytes, and verifies', async () => {
    const key = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    const signature = await Effect.runPromise(
      signSecp256k1({ key, data: BYTES }),
    );

    expect(signature.length).toBe(64);
    expect(secp256k1.Signature.fromBytes(signature).hasHighS()).toBe(false);
    const genuine = await Effect.runPromise(
      verifySecp256k1({ didKey: key.didKey, data: BYTES, signature }),
    );
    expect(genuine).toBe(true);
  });

  it('refuses the high-S twin, which ECDSA would accept as well', async () => {
    const key = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    const signature = await Effect.runPromise(
      signSecp256k1({ key, data: BYTES }),
    );
    const { r, s } = secp256k1.Signature.fromBytes(signature);
    const highS = new secp256k1.Signature(
      r,
      secp256k1.Point.CURVE().n - s,
    ).toBytes();

    const genuine = await Effect.runPromise(
      verifySecp256k1({ didKey: key.didKey, data: BYTES, signature: highS }),
    );
    expect(genuine).toBe(false);
  });

  it('refuses a signature over other bytes, and another signer', async () => {
    const key = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    const other = await Effect.runPromise(
      secp256k1KeyFromScalar(SCALAR.map((byte) => byte + 1)),
    );
    const signature = await Effect.runPromise(
      signSecp256k1({ key, data: BYTES }),
    );

    const altered = await Effect.runPromise(
      verifySecp256k1({
        didKey: key.didKey,
        data: new TextEncoder().encode('an operation, dag-cbor encoded '),
        signature,
      }),
    );
    expect(altered).toBe(false);

    const stranger = await Effect.runPromise(
      verifySecp256k1({ didKey: other.didKey, data: BYTES, signature }),
    );
    expect(stranger).toBe(false);
  });

  it('reads the private half out of a JWK, and refuses another curve', async () => {
    const jwk: JsonWebKey = {
      kty: 'EC',
      crv: 'secp256k1',
      d: base64urlEncode(SCALAR),
    };
    const fromJwk = await Effect.runPromise(importSecp256k1Key(jwk));
    const fromScalar = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    expect(fromJwk.didKey).toBe(fromScalar.didKey);

    const refused = await Effect.runPromise(
      Effect.result(importSecp256k1Key({ ...jwk, crv: 'P-256' })),
    );
    expect(Result.isFailure(refused)).toBe(true);
  });
});
