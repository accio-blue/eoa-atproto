import * as Signing from './signing.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { loadFixture } from './test-utils.js';

interface SignatureFixture {
  comment: string;
  messageBase64: string;
  algorithm: 'ES256' | 'ES256K';
  didDocSuite: string;
  publicKeyDid: string;
  publicKeyMultibase: string;
  signatureBase64: string;
  validSignature: boolean;
  tags: string[];
}

describe('base64url encoding/decoding', () => {
  it('should encode and decode data correctly', () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 255, 254, 253]);
    const encoded = Signing.base64urlEncode(data);
    const decoded = Signing.base64urlDecode(encoded);

    expect(decoded).toEqual(data);
  });

  it('should handle special characters in encoding', () => {
    const data = new Uint8Array([254, 255]); // Would become / and + in base64
    const encoded = Signing.base64urlEncode(data);
    const decoded = Signing.base64urlDecode(encoded);

    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(decoded).toEqual(data);
  });

  it('should round-trip fixture data', () => {
    const fixtures = loadFixture<SignatureFixture[]>(
      'crypto/signature-fixtures.json',
    );
    const fixture = fixtures[0];
    if (!fixture) throw new Error('No fixture found');

    // Note: atproto-interop fixtures use standard base64, not base64url
    // Decode using standard base64
    const binary = atob(fixture.signatureBase64);
    const signatureBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      signatureBytes[i] = binary.charCodeAt(i);
    }

    // Encode as base64url (removing padding and replacing +/ with _-)
    const base64url = Signing.base64urlEncode(signatureBytes);

    expect(base64url).not.toBe(fixture.signatureBase64); // Should differ due to base64url encoding
    expect(base64url).not.toContain('+');
    expect(base64url).not.toContain('/');
    expect(base64url).not.toContain('=');
  });
});

describe('hashing', () => {
  it('should hash data with SHA-256', async () => {
    const data = new TextEncoder().encode('hello world');
    const program = Signing.sha256(data);
    const hash = await Effect.runPromise(program);

    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32); // SHA-256 produces 32 bytes
  });

  it('should produce consistent hash for same input', async () => {
    const data = new TextEncoder().encode('test');
    const hash1 = await Effect.runPromise(Signing.sha256(data));
    const hash2 = await Effect.runPromise(Signing.sha256(data));

    expect(hash1).toEqual(hash2);
  });

  it('should hash fixture messages', async () => {
    const fixtures = loadFixture<SignatureFixture[]>(
      'crypto/signature-fixtures.json',
    );

    for (const fixture of fixtures.slice(0, 2)) {
      if (!fixture) continue;
      // Test first two fixtures
      const messageBytes = Uint8Array.from(atob(fixture.messageBase64), (c) =>
        c.charCodeAt(0),
      );
      const hash = await Effect.runPromise(Signing.sha256(messageBytes));

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    }
  });
});

describe('random key generation', () => {
  it('should generate random keys', async () => {
    const program = Signing.generateRandomKey();
    const key1 = await Effect.runPromise(program);
    const key2 = await Effect.runPromise(program);

    expect(key1).toBeInstanceOf(Uint8Array);
    expect(key1.length).toBe(32);
    expect(key2).toBeInstanceOf(Uint8Array);
    expect(key2).not.toEqual(key1); // Keys should be different
  });

  it('should generate keys with good entropy', async () => {
    const program = Signing.generateRandomKey();
    const key = await Effect.runPromise(program);

    // Check for reasonable distribution (all bytes should be different from zero on average)
    const nonZeroBytes = Array.from(key).filter((b) => b !== 0).length;
    expect(nonZeroBytes).toBeGreaterThan(16); // At least half should be non-zero
  });
});

describe('HMAC', () => {
  it('should compute HMAC-SHA256', async () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const data = new TextEncoder().encode('test message');
    const program = Signing.hmacSha256(key, data);
    const hmac = await Effect.runPromise(program);

    expect(hmac).toBeInstanceOf(Uint8Array);
    expect(hmac.length).toBe(32); // SHA-256 output is 32 bytes
  });

  it('should produce deterministic HMAC for same inputs', async () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const data = new TextEncoder().encode('test message');

    const hmac1 = await Effect.runPromise(Signing.hmacSha256(key, data));
    const hmac2 = await Effect.runPromise(Signing.hmacSha256(key, data));

    expect(hmac1).toEqual(hmac2);
  });
});

describe('signature fixture properties', () => {
  it('should have valid fixture structure', () => {
    const fixtures = loadFixture<SignatureFixture[]>(
      'crypto/signature-fixtures.json',
    );

    expect(Array.isArray(fixtures)).toBe(true);
    expect(fixtures.length).toBeGreaterThan(0);

    const fixture = fixtures[0];
    if (!fixture) throw new Error('No fixture found');
    expect(fixture).toHaveProperty('comment');
    expect(fixture).toHaveProperty('messageBase64');
    expect(fixture).toHaveProperty('signatureBase64');
    expect(fixture).toHaveProperty('validSignature');
  });

  it('should decode all fixture signatures', () => {
    const fixtures = loadFixture<SignatureFixture[]>(
      'crypto/signature-fixtures.json',
    );

    for (const fixture of fixtures) {
      const signature = Signing.base64urlDecode(fixture.signatureBase64);
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBeGreaterThan(0);
    }
  });
});
