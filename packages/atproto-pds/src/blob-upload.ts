/**
 * The upload session of `blob-upload.qnt` (the Effect-PDS map, `m4jw`), as a
 * value.
 *
 * The spec's machine is `phase` over `{empty, uploading, uploaded, failed}` with
 * `bytes` and `limit`, and its rules are the reason it exists:
 *
 * - `appendChunk` is accepted **only while uploading**, and a chunk that would
 *   push the upload past the limit **fails the session and drops the bytes** —
 *   so a refusal costs the size of the chunk, not the size of the upload;
 * - `finish` turns an uploading session with bytes into an uploaded blob, and
 *   leaves anything else exactly where it is — a failed session can never be
 *   finalized;
 * - `discard` returns to empty from anywhere.
 *
 * The session counts bytes; it does not hold them. Whoever is uploading keeps
 * the chunks, and the spec's `bytes' = 0` is the instruction to drop them.
 */

export type BlobPhase = 'empty' | 'uploading' | 'uploaded' | 'failed';

export interface UploadSession {
  readonly phase: BlobPhase;
  /** Bytes accepted so far — zero unless uploading or uploaded. */
  readonly bytes: number;
  readonly limit: number;
}

/** An object literal typed as the session, so `phase` stays a literal. */
const sessionOf = (fields: UploadSession) => ({ ...fields });

/** A session that has not begun: the spec's `init`. */
export const emptySession = (limit: number) =>
  sessionOf({ phase: 'empty', bytes: 0, limit });

/** The spec's `begin`: from empty, an uploading session. */
export const begin = (session: UploadSession) =>
  session.phase === 'empty'
    ? sessionOf({ ...session, phase: 'uploading' })
    : session;

/** The spec's `exceeds`: would this chunk push the upload past the limit? */
export const exceeds = (session: UploadSession, chunk: number) =>
  session.bytes + chunk > session.limit;

/** The spec's `appendChunk`. */
export const appendChunk = (session: UploadSession, chunk: number) =>
  session.phase !== 'uploading'
    ? session
    : exceeds(session, chunk)
      ? sessionOf({ ...session, phase: 'failed', bytes: 0 })
      : sessionOf({ ...session, bytes: session.bytes + chunk });

/** The spec's `finish`: only an uploading session with bytes becomes uploaded. */
export const finish = (session: UploadSession) =>
  session.phase === 'uploading' && session.bytes > 0
    ? sessionOf({ ...session, phase: 'uploaded' })
    : session;

/** The spec's `discard`: empty, from anywhere. */
export const discard = (session: UploadSession) =>
  sessionOf({ ...session, phase: 'empty', bytes: 0 });
