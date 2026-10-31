import { Schema } from 'effect';
import { TID } from '@eoa/core';

/**
 * The commit of a space repo: `com.atproto.space.defs#commit` (spaces alpha, 2026-10-22, section
 * 4a).
 *
 * The October 1 shape was `{ ver, hash, ikm, sig, mac, rev }` — the digest, the key-derivation
 * input, and a signature by the author's `#atproto` key. The alpha replaced all of that with
 * `{ ver, repo, space, rev, data }`:
 *
 * - `data` is the same 32 bytes the old `hash` carried (sha256 of the LtHash state), so stored
 *   digests stay valid and only the name changed;
 * - `ikm`, `sig` and the in-commit `mac` are gone. Authentication moved out of the commit and into
 *   a per-request MAC over a secret agreed through the account's `#atproto_kem` key (`kem.ts`,
 *   `mac.ts`), so a stored or leaked commit proves nothing on its own — which is the point of a
 *   deniable commit.
 *
 * The STAR profile carries this same object plus `$type` in its metadata (`star.ts`).
 */
export const SpaceCommit = Schema.Struct({
  ver: Schema.Literal(1),
  repo: Schema.String,
  space: Schema.String,
  rev: TID,
  data: Schema.Uint8Array,
});

export type SpaceCommit = typeof SpaceCommit.Type;
