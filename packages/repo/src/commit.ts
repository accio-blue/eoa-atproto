import {
  CODEC_DAG_CBOR,
  type Cid,
  CidLink,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
} from '@eoa/core';
import { Effect, Schema, Struct } from 'effect';
import {
  type PrivateKey,
  type PublicKey,
  sha256,
  sign,
  verify,
} from '@eoa/crypto';
import { TID } from './tid.js';

/**
 * A repository commit: the identity of the whole repository at one revision.
 *
 * `data` is the MST root, `prev` the commit before it, and `sig` covers the
 * dag-cbor of the commit *without* `sig` - the same convention as a PLC
 * operation, with one difference that the real repositories settle: a commit's
 * signature is a **byte string**, not base64url text. (The plan said otherwise;
 * the fixture disagrees, and the fixture wins.)
 *
 * The commit's own CID is the CAR's root, so it is the repository's name at
 * that revision - which is why every field here has to be exactly what the
 * reference writes, byte for byte.
 */
export const RepoCommitSchema = Schema.Struct({
  did: Schema.String,
  version: Schema.Literal(3),
  data: Schema.instanceOf(CidLink),
  rev: TID,
  prev: Schema.NullOr(Schema.instanceOf(CidLink)),
  sig: Schema.Uint8Array,
});

export type RepoCommit = Schema.Schema.Type<typeof RepoCommitSchema>;

/** A commit that has not been signed yet: everything but `sig`. */
export type UnsignedCommit = Omit<RepoCommit, 'sig'>;

/**
 * The bytes a signature covers: the commit with `sig` omitted *entirely*, not
 * null. Derived by omission rather than by listing fields, so a field added to
 * a commit cannot silently fall outside its own signature.
 */
const signingBytes = (commit: UnsignedCommit) => encodeCbor(commit);

/** The CID of a commit block: dag-cbor over the commit, signature included. */
export const commitCid = (commit: RepoCommit) =>
  Effect.gen(function* () {
    const digest = yield* sha256(encodeCbor(commit));
    return cidFromDigest({ codec: CODEC_DAG_CBOR, digest });
  });

/** Build and sign a commit. */
export const signCommit = (params: {
  readonly did: string;
  readonly data: Cid;
  readonly rev: TID;
  readonly previous: Cid | undefined;
  readonly key: PrivateKey;
}) =>
  Effect.gen(function* () {
    const unsigned = {
      did: params.did,
      version: 3 as const,
      data: new CidLink({ cid: params.data }),
      rev: params.rev,
      prev:
        params.previous === undefined
          ? null
          : new CidLink({ cid: params.previous }),
    };

    const sig = yield* sign(params.key, signingBytes(unsigned));
    return { ...unsigned, sig };
  });

/**
 * Verify a commit against the key that should have signed it. A false answer is
 * as final as an error: the commit is not usable either way.
 */
export const verifyCommit = (params: {
  readonly commit: RepoCommit;
  readonly key: PublicKey;
}) =>
  verify(
    params.key,
    signingBytes(Struct.omit(params.commit, ['sig'])),
    params.commit.sig,
  );

/** Decode a commit block, rejecting anything that is not a commit. */
export const decodeCommit = (bytes: Uint8Array) =>
  Schema.decodeUnknownSync(RepoCommitSchema)(decodeCbor(bytes));
