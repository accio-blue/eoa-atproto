import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportPrivateKey,
  generateES256KeyPair,
  importPrivateKey,
} from './keys.js';
import { Effect } from 'effect';

/**
 * The derived public key must be imported with the usage being requested, not the
 * private key's.
 *
 * Chromium enforces a JWK's `key_ops` against the import call's usages and rejects
 * a mismatch ("the JWK usage must be a superset of those requested"); Node's
 * WebCrypto ignores it. A private export carries `key_ops: ['sign']`, and
 * `importPrivateKey` derives the public JWK from it — so without the override,
 * loading a stored DPoP key works in tests and throws in the browser. This asserts
 * what is handed to `importKey`, which is the only place the difference is visible
 * outside Chromium.
 */
describe('importPrivateKey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('imports the derived public key with key_ops ["verify"]', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey');

    const pair = await Effect.runPromise(generateES256KeyPair());
    const privateJwk = await Effect.runPromise(
      exportPrivateKey(pair.privateKey),
    );
    expect(privateJwk.key_ops).toEqual(['sign']);

    await Effect.runPromise(importPrivateKey(privateJwk));

    expect(importKey.mock.calls).toHaveLength(2);
    const derivedPublic = importKey.mock.calls[1]!;
    expect(derivedPublic[0]).toBe('jwk');
    expect(derivedPublic[1]).toMatchObject({ key_ops: ['verify'] });
    expect(derivedPublic[4]).toEqual(['verify']);
  });
});
