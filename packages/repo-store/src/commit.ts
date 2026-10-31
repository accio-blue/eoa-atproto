import {
  CODEC_DAG_CBOR,
  type Cid,
  CidLink,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
} from '@eoa/core';
import { Effect, Schema, Struct } from 'effect';
import type { PrivateKey, PublicKey } from '@eoa/crypto';
import { sha256, sign, verify } from '@eoa/crypto';

/**
 * The repo's commit: what a repository *is* at a revision.
 *
 * Its own CID is the repo's name at that revision — the root of a CAR, and what
 * a client compares to decide whether its copy is current — so every field has
 * to be exactly what the reference writes, byte for byte. `data` is the MST
 * root; `prev` chains to the commit before it; `rev` is a TID.
 */
export const CommitSchema = Schema.Struct({
  did: Schema.String,
  version: Schema.Literal(3),
  data: Schema.instanceOf(CidLink),
  rev: Schema.String,
  prev: Schema.NullOr(Schema.instanceOf(CidLink)),
  sig: Schema.Uint8Array,
});

export type Commit = Schema.Schema.Type<typeof CommitSchema>;

/** A commit that has not been signed yet: everything but `sig`. */
export type UnsignedCommit = Omit<Commit, 'sig'>;

/**
 * The bytes a signature covers: the commit with `sig` omitted *entirely*, not
 * null. Derived by omission rather than by listing fields, so a field added to a
 * commit cannot silently fall outside its own signature.
 */
const signingBytes = (commit: UnsignedCommit) => encodeCbor(commit);

/** The CID of a commit block: dag-cbor over the commit, signature included. */
export const commitCid = (commit: Commit) =>
  Effect.gen(function* () {
    const digest = yield* sha256(encodeCbor(commit));
    return cidFromDigest({ codec: CODEC_DAG_CBOR, digest });
  });

/** Build and sign a commit. */
export const signCommit = (params: {
  readonly did: string;
  readonly data: Cid;
  readonly rev: string;
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
  readonly commit: Commit;
  readonly key: PublicKey;
}) =>
  verify(
    params.key,
    signingBytes(Struct.omit(params.commit, ['sig'])),
    params.commit.sig,
  );

/** Decode a commit block, rejecting anything that is not a commit. */
export const decodeCommit = (bytes: Uint8Array) =>
  Schema.decodeUnknownSync(CommitSchema)(decodeCbor(bytes));
