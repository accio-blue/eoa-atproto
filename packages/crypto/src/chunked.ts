import {
  Decrypter,
  Encrypter,
  type Sliceable,
  ciphertextSize,
  generateKey,
  plaintextSize,
} from 'cobblestone-encryption';
import { CryptoError } from './keys.js';
import { Effect } from 'effect';

/**
 * Cobblestone-128 chunked encryption (c2sp.org/chunked-encryption) for blobs in
 * permissioned spaces.
 *
 * The format and the chunk arithmetic are the reference implementation's: a
 * 56-byte header, 16 KiB chunks, AES-128-GCM + HKDF-SHA-512. `openChunkedBlob`
 * authenticates the size up front (the last chunk) and then only fetches and
 * authenticates the chunks a range read touches, so a range of an encrypted
 * blob does not decrypt the whole object.
 *
 * Key management is deliberately not here: the 16-byte key comes from the
 * caller (the space's KMS), and `context` is the non-secret binding the caller
 * chooses (a space DID, a record key, a filename). The context is not stored in
 * the ciphertext; both sides must know it.
 */
export const CHUNKED_KEY_SIZE = 16;

const failure = (operation: string) => (cause: unknown) =>
  new CryptoError({ cause, operation });

/** A fresh uniformly random Cobblestone-128 key (never derive it from a password). */
export const generateChunkedKey = () =>
  Effect.try({
    try: () => generateKey(),
    catch: failure('chunked-key-generation'),
  });

/** Encrypt one message; a fresh random salt is used each call. */
export const encryptChunked = (
  key: Uint8Array,
  plaintext: Uint8Array,
  context?: string,
) =>
  Effect.tryPromise({
    try: () =>
      (context === undefined
        ? new Encrypter(key)
        : new Encrypter(key, context)
      ).encrypt(plaintext),
    catch: failure('chunked-encryption'),
  });

/** Decrypt one message in memory. */
export const decryptChunked = (
  key: Uint8Array,
  ciphertext: Uint8Array,
  context?: string,
) =>
  Effect.tryPromise({
    try: () =>
      (context === undefined
        ? new Decrypter(key)
        : new Decrypter(key, context)
      ).decrypt(ciphertext),
    catch: failure('chunked-decryption'),
  });

/**
 * Open an authenticated random-access view of a ciphertext. `source` is a
 * `Blob`/`File` or any `Sliceable` backed by range requests; the returned
 * `DecryptedBlob` exposes `slice`/`bytes`/`stream`.
 */
export const openChunkedBlob = (
  key: Uint8Array,
  source: Sliceable,
  context?: string,
) =>
  Effect.tryPromise({
    try: () =>
      (context === undefined
        ? new Decrypter(key)
        : new Decrypter(key, context)
      ).decryptBlob(source),
    catch: failure('chunked-open'),
  });

/** Size in ciphertext bytes before a single byte is encrypted. */
export const chunkedCiphertextSize = (size: number) =>
  Effect.try({
    try: () => ciphertextSize(size),
    catch: failure('chunked-size'),
  });

/** Plaintext size of a valid ciphertext size; every other size is an error. */
export const chunkedPlaintextSize = (size: number) =>
  Effect.try({
    try: () => plaintextSize(size),
    catch: failure('chunked-size'),
  });
