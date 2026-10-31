import {
  CODEC_DAG_CBOR,
  type CborValue,
  cidFromDigest,
  encodeCbor,
  formatCid,
  parseCid,
} from '@eoa/core';
import type { CryptoError, PrivateKey } from '@eoa/crypto';
import { Data, Effect, Match, Option, Result, Schema } from 'effect';
import {
  type MstMutationError,
  addLeaves,
  emptyTree,
  encodeTree,
} from './mst-tree.js';
import { commitCid, signCommit } from './commit.js';
import { CorruptRow } from './types.js';
import type { KvError } from '@eoa/kv';
import { MstLeaf } from './mst.js';
import { RepoStore } from './repo-store.js';
import { nextTid } from './tid.js';
import { sha256 } from '@eoa/crypto';

/** A write to a repo that is not there. */
export class NoSuchRepo extends Schema.TaggedError<NoSuchRepo>()('NoSuchRepo', {
  did: Schema.String,
}) {}

/** A revision in the head that is not a CID. */
export class InvalidHead extends Schema.TaggedError<InvalidHead>()(
  'InvalidHead',
  { did: Schema.String, root: Schema.String },
) {}

/** A put that names neither a record value nor the record's bytes. */
export class EmptyPut extends Schema.TaggedError<EmptyPut>()('EmptyPut', {
  key: Schema.String,
}) {}

/** One operation a commit performed, derived by diffing the trees around it. */
export interface CommitOp {
  readonly action: 'create' | 'update' | 'delete';
  /** The record's tree key: `<collection>/<rkey>`. */
  readonly path: string;
  /** The record's CID; `null` on a delete, which has no record. */
  readonly cid: string | null;
}

/** A block a commit's reader needs, under the CID it is addressed by. */
export interface CommitBlock {
  /** The formatted CID — the same string a record's `$link` carries. */
  readonly cid: string;
  readonly bytes: Uint8Array;
}

/** What a write did: the spec's `committed`, or its `conflict`. */
export type WriteOutcomeMap = Data.TaggedEnum<{
  readonly committed: {
    readonly commit: string;
    readonly rev: string;
    /** The commit this one replaced, or `null` for a repo's first. */
    readonly since: string | null;
    readonly ops: ReadonlyArray<CommitOp>;
    /**
     * What a reader of this commit needs: the commit block, the tree's nodes and
     * the records the operations touched. Not the whole repo — a relay ingests
     * exactly what changed.
     */
    readonly blocks: ReadonlyArray<CommitBlock>;
  };
  readonly conflicted: { readonly head: string };
}>;

export const { committed: writeCommitted, conflicted: writeConflicted } =
  Data.taggedEnum<WriteOutcomeMap>();

/** A record to put: its value when the caller has one, else its exact bytes. */
export type RepoPut = {
  readonly key: string;
  readonly record?: CborValue;
  /** The record's bytes when the caller has them (an import). Preferred. */
  readonly bytes?: Uint8Array;
};

/** One write in a batch: a record to put, or one to remove. */
export type RepoWriteMap = Data.TaggedEnum<{
  readonly put: RepoPut;
  readonly remove: { readonly key: string };
}>;

export const { put: writePut, remove: writeRemove } =
  Data.taggedEnum<RepoWriteMap>();

/**
 * The bytes a put carries: the caller's own when it has them (an import — a
 * record's identity *is* its bytes), else the canonical encoding of its value.
 * Re-encoding a record the caller handed us as bytes is what moves its CID.
 */
const bytesOfPut = (one: RepoPut) =>
  one.bytes !== undefined
    ? Effect.succeed(one.bytes)
    : one.record !== undefined
      ? Effect.succeed(encodeCbor(one.record))
      : Effect.fail(new EmptyPut({ key: one.key }));

export type WriteError =
  | CorruptRow
  | CryptoError
  | EmptyPut
  | InvalidHead
  | KvError
  | MstMutationError
  | NoSuchRepo;

/** Any key sorts before this, so a scan to here is a scan of everything. */
const AFTER_EVERYTHING = '\uffff';

/** The repo's records as the tree wants them: each one's CID. */
const currentLeaves = (store: RepoStore['Service'], did: string) =>
  store.leaves(did, '', AFTER_EVERYTHING).pipe(
    Effect.flatMap((records) =>
      Effect.forEach(records, (one) =>
        Effect.gen(function* () {
          const digest = yield* sha256(one.value);
          return new MstLeaf({
            key: one.key,
            value: cidFromDigest({ codec: CODEC_DAG_CBOR, digest }),
          });
        }),
      ),
    ),
  );

const cidOf = (did: string, root: string) => {
  const parsed = parseCid(root);
  return Result.isFailure(parsed)
    ? Effect.fail(new InvalidHead({ did, root }))
    : Effect.succeed(parsed.success);
};

/** Start a repo: an empty tree, one signed commit, and its head. */
export const createRepo = (params: {
  readonly did: string;
  readonly signingKey: PrivateKey;
  readonly now: number;
  readonly clockId: number;
}) =>
  Effect.gen(function* () {
    const store = yield* RepoStore;
    const encoded = yield* encodeTree(emptyTree());
    const rev = yield* nextTid({ now: params.now, clockId: params.clockId });
    const commit = yield* signCommit({
      did: params.did,
      data: encoded.root,
      rev,
      previous: undefined,
      key: params.signingKey,
    });
    const cid = formatCid(yield* commitCid(commit));
    yield* store.commitAll({
      did: params.did,
      puts: [],
      deletes: [],
      // The empty tree's root is a node too, and a reader that gets the commit without it cannot walk
      // the repo: `sync.getRepo` serves the blocks the store holds, and an account that has written
      // nothing yet would otherwise hand out a CAR missing its own root. `applyWrites` already keeps
      // every block; this is the one path that made a commit whose tree was not on disk.
      nodes: [...encoded.blocks].map(([node, block]) => ({
        cid: node,
        bytes: block.bytes,
      })),
      commit: { cid, bytes: encodeCbor(commit) },
      head: { root: cid, rev },
    });
    return { commit: cid, rev };
  });

/**
 * The repo write path, as `repo-write.qnt` states it.
 *
 * The spec's machine is `phase` over `{idle, validated, committed, conflict}`,
 * driven by `submit(seen)` — a write carrying the commit it observed — then
 * `commitWrite` and `reload`. Its rules are the ones here:
 *
 * - `submit` with no observed commit (`seen == -1`) or with the current one
 *   validates; **anything else is a conflict**;
 * - a conflict **leaves the repo untouched** (`commit' = commit`,
 *   `record' = record`);
 * - `commitWrite` advances the commit by exactly one (`commit' = staged =
 *   commit + 1`) and leaves nothing dirty (`mstDirty' = false`) — which here
 *   means the head already points at the new commit, with no pending write.
 *
 * A batch is one commit, because that is what `applyWrites` is: the spec's
 * `staged` is a set, not a single record.
 */
export const applyWrites = (params: {
  readonly did: string;
  readonly writes: ReadonlyArray<RepoWriteMap>;
  readonly swapCommit: string | undefined;
  readonly signingKey: PrivateKey;
  readonly now: number;
  readonly clockId: number;
}) =>
  Effect.gen(function* () {
    const store = yield* RepoStore;
    const head = yield* store.head(params.did);
    if (Option.isNone(head)) {
      return yield* Effect.fail(new NoSuchRepo({ did: params.did }));
    }
    const at = head.value;

    // submit: a stale observed commit is a conflict, and the repo is untouched.
    if (params.swapCommit !== undefined && params.swapCommit !== at.root) {
      return writeConflicted({ head: at.root });
    }

    const puts = params.writes.flatMap((write) =>
      Match.value(write).pipe(
        Match.tag('put', (one) => [one]),
        Match.orElse(() => []),
      ),
    );
    const removed = params.writes.flatMap((write) =>
      Match.value(write).pipe(
        Match.tag('remove', (one) => [one.key]),
        Match.orElse(() => []),
      ),
    );

    const blocks = yield* Effect.forEach(puts, (one) =>
      Effect.gen(function* () {
        const bytes = yield* bytesOfPut(one);
        const digest = yield* sha256(bytes);
        return {
          key: one.key,
          bytes,
          cid: cidFromDigest({ codec: CODEC_DAG_CBOR, digest }),
        };
      }),
    );

    // The tree's shape is fixed by its keys, so rebuilding it from the records
    // is the same tree a reader would walk — and it is why the leaves *are* the
    // records: nothing about them is stored anywhere else.
    const existing = yield* currentLeaves(store, params.did);
    const written = new Set(blocks.map((block) => block.key));
    // The records that survive the batch: what the old tree and the new one have
    // in common, which is what the diff below is read against.
    const kept = existing.filter(
      (leaf) => !written.has(leaf.key) && !removed.includes(leaf.key),
    );
    const tree = yield* addLeaves({
      node: emptyTree(),
      leaves: [
        ...kept,
        ...blocks.map(
          (block) => new MstLeaf({ key: block.key, value: block.cid }),
        ),
      ],
    });
    const encoded = yield* encodeTree(tree);

    // commitWrite: the records, every node the tree points at, the commit, and
    // the head — in that order, so the head is the last thing that moves. Every
    // node, including one that holds only leaves: a CAR that omits one cannot be
    // walked, because a reader has the tree and not the records to rebuild it
    // from.
    const rev = yield* nextTid({ now: params.now, clockId: params.clockId });
    const commit = yield* signCommit({
      did: params.did,
      data: encoded.root,
      rev,
      previous: yield* cidOf(params.did, at.root),
      key: params.signingKey,
    });
    const cid = formatCid(yield* commitCid(commit));
    // The records, every node the tree points at, the commit and the head -- in **one** storage
    // commit. Four separate ones cost four bookkeeping rows and four head reads for one record.
    yield* store.commitAll({
      did: params.did,
      puts: blocks.map((block) => ({ key: block.key, value: block.bytes })),
      deletes: removed,
      nodes: [...encoded.blocks].map(([node, block]) => ({
        cid: node,
        bytes: block.bytes,
      })),
      commit: { cid, bytes: encodeCbor(commit) },
      head: { root: cid, rev },
    });

    // What the commit did, by diffing the trees around it: a key only in the new
    // tree was created, one whose CID changed was updated, and one only in the
    // old tree was deleted. A caller knows what it asked for; only the trees know
    // whether that created a record or replaced one.
    const before = new Map(
      existing.map((leaf) => [leaf.key, formatCid(leaf.value)]),
    );
    const after = new Map(
      [
        ...kept,
        ...blocks.map(
          (block) => new MstLeaf({ key: block.key, value: block.cid }),
        ),
      ].map((leaf) => [leaf.key, formatCid(leaf.value)]),
    );
    const created = [...after].flatMap(([path, record]) =>
      before.has(path)
        ? []
        : [{ action: 'create' as const, path, cid: record }],
    );
    const updated = [...after].flatMap(([path, record]) => {
      const was = before.get(path);
      return was === undefined || was === record
        ? []
        : [{ action: 'update' as const, path, cid: record }];
    });
    const deleted = [...before.keys()].flatMap((path) =>
      after.has(path) ? [] : [{ action: 'delete' as const, path, cid: null }],
    );
    const ops: ReadonlyArray<CommitOp> = [
      ...created,
      ...updated,
      ...deleted,
    ].sort((left, right) => (left.path < right.path ? -1 : 1));

    return writeCommitted({
      commit: cid,
      rev,
      since: at.root,
      ops,
      blocks: [
        { cid, bytes: encodeCbor(commit) },
        ...[...encoded.blocks].map(([node, block]) => ({
          cid: node,
          bytes: block.bytes,
        })),
        ...blocks.map((block) => ({
          cid: formatCid(block.cid),
          bytes: block.bytes,
        })),
      ],
    });
  });

/** One write: the batch of one, which is what `createRecord` is. */
export const applyWrite = (params: {
  readonly did: string;
  readonly key: string;
  readonly record: CborValue;
  readonly swapCommit: string | undefined;
  readonly signingKey: PrivateKey;
  readonly now: number;
  readonly clockId: number;
}) =>
  applyWrites({
    did: params.did,
    writes: [writePut({ key: params.key, record: params.record })],
    swapCommit: params.swapCommit,
    signingKey: params.signingKey,
    now: params.now,
    clockId: params.clockId,
  });
