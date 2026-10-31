import { describe, expect, it } from 'vitest';
import {
  generateP256SecretKey,
  hkdfSha256,
  p256PublicPoint,
  p256SharedSecret,
} from './index.js';
import { Effect } from 'effect';

const run = Effect.runPromise;

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('hkdfSha256', () => {
  it('matches RFC 5869 test case 1', async () => {
    // Extract then expand: a hand-rolled "one block of expand" gets this wrong as
    // soon as the salt is not empty, which is exactly what this vector catches.
    const okm = await run(
      hkdfSha256({
        ikm: bytes('0b'.repeat(22)),
        salt: bytes('000102030405060708090a0b0c'),
        info: bytes('f0f1f2f3f4f5f6f7f8f9'),
        length: 42,
      }),
    );

    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('gives 32 bytes when 32 are asked for', async () => {
    const okm = await run(
      hkdfSha256({
        ikm: new Uint8Array(32).fill(1),
        salt: new Uint8Array(),
        info: new Uint8Array(),
        length: 32,
      }),
    );

    expect(okm.length).toBe(32);
  });
});

describe('p256 ECDH', () => {
  it('agrees from both sides, and only the x-coordinate comes out', async () => {
    const alice = await run(generateP256SecretKey());
    const bob = await run(generateP256SecretKey());
    const alicePoint = await run(p256PublicPoint(alice));
    const bobPoint = await run(p256PublicPoint(bob));

    const fromAlice = await run(
      p256SharedSecret({ secretKey: alice, publicKey: bobPoint }),
    );
    const fromBob = await run(
      p256SharedSecret({ secretKey: bob, publicKey: alicePoint }),
    );

    expect(alicePoint.length).toBe(65);
    expect(fromAlice.length).toBe(32);
    expect(hex(fromAlice)).toBe(hex(fromBob));
  });

  it('gives different secrets for different peers', async () => {
    const alice = await run(generateP256SecretKey());
    const bob = await run(generateP256SecretKey());
    const mallory = await run(generateP256SecretKey());

    const withBob = await run(
      p256SharedSecret({
        secretKey: alice,
        publicKey: await run(p256PublicPoint(bob)),
      }),
    );
    const withMallory = await run(
      p256SharedSecret({
        secretKey: alice,
        publicKey: await run(p256PublicPoint(mallory)),
      }),
    );

    expect(hex(withBob)).not.toBe(hex(withMallory));
  });
});
