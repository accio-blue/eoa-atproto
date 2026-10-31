import {
  CHUNKED_KEY_SIZE,
  chunkedCiphertextSize,
  chunkedPlaintextSize,
  decryptChunked,
  encryptChunked,
  generateChunkedKey,
  openChunkedBlob,
} from './chunked.js';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './keys.js';
import { Effect } from 'effect';

const CONTEXT = 'atproto.space:did:plc:example';

const plaintext = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 31) % 256);

const ciphertextFor = async (length: number) => {
  const key = await Effect.runPromise(generateChunkedKey());
  return Effect.runPromise(encryptChunked(key, plaintext(length), CONTEXT));
};

describe('chunked encryption', () => {
  it('round-trips a multi-chunk message and reports its sizes', async () => {
    const key = await Effect.runPromise(generateChunkedKey());
    expect(key).toHaveLength(CHUNKED_KEY_SIZE);

    const message = plaintext(40_000);
    const ciphertext = await Effect.runPromise(
      encryptChunked(key, message, CONTEXT),
    );
    expect(ciphertext.byteLength).toBe(
      await Effect.runPromise(chunkedCiphertextSize(message.byteLength)),
    );
    expect(
      await Effect.runPromise(chunkedPlaintextSize(ciphertext.byteLength)),
    ).toBe(message.byteLength);

    const decrypted = await Effect.runPromise(
      decryptChunked(key, ciphertext, CONTEXT),
    );
    expect(decrypted).toEqual(message);
  });

  it('authenticates the context, so a different binding fails', async () => {
    const key = await Effect.runPromise(generateChunkedKey());
    const ciphertext = await Effect.runPromise(
      encryptChunked(key, plaintext(100), CONTEXT),
    );
    await expect(
      Effect.runPromise(decryptChunked(key, ciphertext, 'another space')),
    ).rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects a truncated ciphertext instead of returning a prefix', async () => {
    const key = await Effect.runPromise(generateChunkedKey());
    const ciphertext = await Effect.runPromise(
      encryptChunked(key, plaintext(40_000), CONTEXT),
    );
    await expect(
      Effect.runPromise(
        decryptChunked(key, ciphertext.slice(0, ciphertext.byteLength - 1)),
      ),
    ).rejects.toBeInstanceOf(CryptoError);
  });

  it('opens a range without decrypting the rest of the blob', async () => {
    const key = await Effect.runPromise(generateChunkedKey());
    const message = plaintext(40_000);
    const ciphertext = await Effect.runPromise(
      encryptChunked(key, message, CONTEXT),
    );

    const opened = await Effect.runPromise(
      openChunkedBlob(key, new Blob([ciphertext]), CONTEXT),
    );
    expect(opened.size).toBe(message.byteLength);
    expect(await opened.slice(16_384, 32_768).bytes()).toEqual(
      message.slice(16_384, 32_768),
    );
    expect(await opened.bytes()).toEqual(message);
  });

  it('a range read gets no plaintext if the header is wrong', async () => {
    const key = await Effect.runPromise(generateChunkedKey());
    const ciphertext = await ciphertextFor(40_000);
    await expect(
      Effect.runPromise(openChunkedBlob(key, new Blob([ciphertext]))),
    ).rejects.toBeInstanceOf(CryptoError);
  });
});
