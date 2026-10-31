import {
  appendChunk,
  begin,
  discard,
  emptySession,
  exceeds,
  finish,
} from './blob-upload.js';
import { describe, expect, it } from 'vitest';

/**
 * The machine's rules are `blob-upload.qnt`'s, so this is the spec's boundary
 * cases run against the implementation: a chunk that would exceed the limit
 * fails the session and drops the bytes, a failed session can never be
 * finalized, and `discard` returns to empty from anywhere.
 */

const LIMIT = 1024;

const nothing = { phase: 'empty', bytes: 0, limit: LIMIT };

describe('the upload session (spec-only)', () => {
  it('is empty until it begins, and begins only from empty', () => {
    expect(emptySession(LIMIT)).toEqual(nothing);
    const uploading = begin(emptySession(LIMIT));
    expect(uploading).toEqual({ phase: 'uploading', bytes: 0, limit: LIMIT });
    // begin is an action from `empty`, so a second one moves nothing.
    expect(begin(uploading)).toEqual(uploading);
  });

  it('accepts chunks only while uploading', () => {
    const uploading = begin(emptySession(LIMIT));
    const one = appendChunk(uploading, 128);
    expect(one).toEqual({ phase: 'uploading', bytes: 128, limit: LIMIT });
    const two = appendChunk(one, 512);
    expect(two).toEqual({ phase: 'uploading', bytes: 640, limit: LIMIT });
    // A session that never began takes nothing.
    expect(appendChunk(emptySession(LIMIT), 128)).toEqual(nothing);
    // And an uploaded one takes nothing more.
    expect(appendChunk(finish(two), 1)).toEqual(finish(two));
  });

  it('fails on a chunk that would exceed the limit, and drops the bytes', () => {
    const uploading = begin(emptySession(LIMIT));
    // Exactly the limit is not exceeding it.
    const full = appendChunk(uploading, LIMIT);
    expect(full).toEqual({ phase: 'uploading', bytes: LIMIT, limit: LIMIT });
    const over = appendChunk(full, 1);
    expect(over).toEqual({ phase: 'failed', bytes: 0, limit: LIMIT });
    // The spec's invariant: a failed upload retains no bytes...
    expect(over.bytes).toBe(0);
    // ...and its `finish` leaves it failed, so it can never be finalized.
    expect(finish(over)).toEqual(over);
    expect(appendChunk(over, 1)).toEqual(over);
  });

  it('finalizes only an uploading session that has bytes', () => {
    const uploading = begin(emptySession(LIMIT));
    expect(finish(uploading)).toEqual(uploading);
    const withBytes = appendChunk(uploading, 1);
    const uploaded = finish(withBytes);
    expect(uploaded).toEqual({ phase: 'uploaded', bytes: 1, limit: LIMIT });
    // Finalizing again is a no-op, and an uploaded session keeps its bytes.
    expect(finish(uploaded)).toEqual(uploaded);
  });

  it('discards from anywhere', () => {
    const uploading = appendChunk(begin(emptySession(LIMIT)), 128);
    const uploaded = finish(uploading);
    const failed = appendChunk(begin(emptySession(LIMIT)), LIMIT + 1);
    for (const session of [uploading, uploaded, failed]) {
      expect(discard(session)).toEqual(nothing);
    }
  });

  it('exceeds is the spec’s arithmetic', () => {
    const fresh = begin(emptySession(LIMIT));
    expect(exceeds(fresh, LIMIT)).toBe(false);
    expect(exceeds(fresh, LIMIT + 1)).toBe(true);
    const part = appendChunk(fresh, 100);
    expect(exceeds(part, 924)).toBe(false);
    expect(exceeds(part, 925)).toBe(true);
  });
});
