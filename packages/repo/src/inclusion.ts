import { type Cid, formatCid } from '@eoa/core';
import { Effect, Schema } from 'effect';
import { type PublicKey, base64urlEncode, sha256 } from '@eoa/crypto';
import { recordCid, repoFromCar, verifyRepo } from './repo.js';

/**
 * Install-time verification for a signed release (bean `effects-of-atmosphere-blf2`,
 * the registry's EmDash-shaped half).
 *
 * A registry catalog is untrusted: publishing a record into it says nothing
 * about who made the code. So an install does not trust the catalog — it checks
 * the publisher's **own** signed repository. Given the CAR a publisher served and
 * the key that should have signed it, this asserts two things about one record:
 *
 * 1. the commit that names it carries a valid signature for the publisher's key
 *    (`verifyRepo`, the same check any atproto consumer makes), and
 * 2. the record's key resolves to **exactly** the CID the release declared.
 *
 * A catalog can list a plugin, but it cannot swap in different code: a different
 * record has a different CID, and a different CID at that key fails here.
 */

/** Reported when a record is not proven to be in the publisher's signed repo. */
export class InclusionError extends Schema.TaggedError<InclusionError>()(
  'InclusionError',
  {
    message: Schema.String,
  },
) {}

export const verifyRecordInclusion = (params: {
  /** The CARv1 the publisher served (the commit, its tree, its records). */
  readonly car: Uint8Array;
  /** The key that should have signed the commit (the publisher's DID key). */
  readonly key: PublicKey;
  readonly collection: string;
  readonly rkey: string;
  /** The record CID the release declared, formatted. */
  readonly cid: string;
}) =>
  Effect.gen(function* () {
    const repo = yield* repoFromCar(params.car);

    if (!(yield* verifyRepo({ repo, key: params.key }))) {
      return yield* new InclusionError({
        message: 'the commit signature does not match the publisher key',
      });
    }

    const found: Cid | undefined = recordCid({
      repo,
      collection: params.collection,
      rkey: params.rkey,
    });
    if (found === undefined) {
      return yield* new InclusionError({
        message: `${params.collection}/${params.rkey} is not in the signed commit`,
      });
    }

    const actual = formatCid(found);
    if (actual !== params.cid) {
      return yield* new InclusionError({
        message: `the record at ${params.collection}/${params.rkey} is ${actual}, not the declared ${params.cid}`,
      });
    }

    return { cid: actual };
  }).pipe(
    Effect.withSpan('repo.verifyRecordInclusion', {
      attributes: {
        'repo.record': `${params.collection}/${params.rkey}`,
      },
    }),
  );

/** The artifact a release declares: its checksum and, optionally, its size. */
export interface ReleaseArtifact {
  /** `base64url(sha256(bytes))`. */
  readonly sha256: string;
  /** The artifact's size in bytes, when the release declares one. */
  readonly size?: number;
}

/** Reported when an artifact does not match its release record. */
export class ReleaseMismatchError extends Schema.TaggedError<ReleaseMismatchError>()(
  'ReleaseMismatchError',
  {
    message: Schema.String,
  },
) {}

/**
 * Install-time verification, end to end: the release record is in the
 * publisher's signed repo (`verifyRecordInclusion`), and the artifact bytes hash
 * to the checksum the record declared. An untrusted catalog can then neither
 * swap the record nor the code.
 */
export const verifyRelease = (params: {
  readonly car: Uint8Array;
  readonly key: PublicKey;
  readonly collection: string;
  readonly rkey: string;
  readonly cid: string;
  readonly artifact: ReleaseArtifact;
  readonly bytes: Uint8Array;
}) =>
  Effect.gen(function* () {
    const { cid } = yield* verifyRecordInclusion({
      car: params.car,
      key: params.key,
      collection: params.collection,
      rkey: params.rkey,
      cid: params.cid,
    });

    const checksum = base64urlEncode(yield* sha256(params.bytes));
    if (checksum !== params.artifact.sha256) {
      return yield* new ReleaseMismatchError({
        message: `the artifact hashes to ${checksum}, not the declared ${params.artifact.sha256}`,
      });
    }
    if (
      params.artifact.size !== undefined &&
      params.bytes.length !== params.artifact.size
    ) {
      return yield* new ReleaseMismatchError({
        message: `the artifact is ${params.bytes.length} bytes, not the declared ${params.artifact.size}`,
      });
    }

    return { cid, sha256: checksum };
  }).pipe(
    Effect.withSpan('repo.verifyRelease', {
      attributes: { 'repo.record': `${params.collection}/${params.rkey}` },
    }),
  );
