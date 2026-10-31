import {
  type Block,
  type BlockSet,
  MstChild,
  type MstNode,
  type MstTreeEntry,
  addLeaf,
  emptyTree,
  encodeTree,
  leaves,
  lookup,
  removeLeaf,
} from './mst-tree.js';
import {
  CODEC_DAG_CBOR,
  type CborValue,
  type Cid,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import { Effect, Schema } from 'effect';
import {
  MstLeaf,
  type MstNodeEntry,
  MstSubtree,
  decodeNodeData,
  deserializeNodeData,
  layerForEntries,
} from './mst.js';
import { type PrivateKey, type PublicKey, sha256 } from '@eoa/crypto';
import {
  type RepoCommit,
  commitCid,
  decodeCommit,
  signCommit,
  verifyCommit,
} from './commit.js';
import { encodeCar, readCar } from './car.js';
import { nextTid, tidClockId } from './tid.js';

/**
 * A repository: the records, the tree that names them, and the commit that
 * signs the whole thing.
 *
 * The store is in memory and holds no history - only the current revision,
 * exactly like the CAR a PDS serves. `prev` is the previous commit's CID, so a
 * repository *names* its history without carrying it.
 *
 * A record's block is kept as bytes and keyed by CID, which is the shape both a
 * CAR and a lookup want; the tree's leaves point straight at those CIDs.
 */

/** A repository at one revision. */
export type Repo = {
  readonly commit: RepoCommit;
  readonly tree: MstNode;
  /** Record blocks by CID: what the tree's leaves point at. */
  readonly records: BlockSet;
};

/** The tree and the record blocks, before they are committed. */
type RepoState = {
  readonly tree: MstNode;
  readonly records: BlockSet;
};

/** One write in a batch. `create` and `update` are the same write. */
export type RepoWrite =
  | {
      readonly action: 'create' | 'update';
      readonly collection: string;
      readonly rkey: string;
      readonly record: CborValue;
    }
  | {
      readonly action: 'delete';
      readonly collection: string;
      readonly rkey: string;
    };

/** Reported when a repository cannot be assembled from the blocks it was given. */
export class RepoReadError extends Schema.TaggedError<RepoReadError>()(
  'RepoReadError',
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The MST key of a record: `<collection>/<rkey>`. */
export const recordKey = (params: {
  readonly collection: string;
  readonly rkey: string;
}) => `${params.collection}/${params.rkey}`;

/** The CID of a record's block: dag-cbor over the record. */
const blockOfRecord = (record: CborValue) =>
  Effect.gen(function* () {
    const bytes = encodeCbor(record);
    const digest = yield* sha256(bytes);
    return {
      cid: cidFromDigest({ codec: CODEC_DAG_CBOR, digest }),
      bytes,
    } satisfies Block;
  });

/** Insert or replace a leaf: `addLeaf` refuses a key that is already there. */
const setLeaf = (params: {
  readonly tree: MstNode;
  readonly key: string;
  readonly value: Cid;
}) =>
  Effect.gen(function* () {
    if (lookup({ node: params.tree, key: params.key }) === undefined) {
      return yield* addLeaf({
        node: params.tree,
        key: params.key,
        value: params.value,
      });
    }
    const without = yield* removeLeaf({ node: params.tree, key: params.key });
    return yield* addLeaf({
      node: without,
      key: params.key,
      value: params.value,
    });
  });

/** The record blocks a tree still refers to: everything else is dead weight. */
const recordsOf = (params: {
  readonly tree: MstNode;
  readonly records: BlockSet;
}) =>
  new Map(
    leaves(params.tree).flatMap((leaf) => {
      const key = formatCid(leaf.value);
      const block = params.records.get(key);
      return block === undefined ? [] : [[key, block] as const];
    }),
  );

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/**
 * Commit a tree: a new revision, signed, with the previous commit behind it.
 * The `rev` is strictly newer than the last one, so writes have an order even
 * when the clock does not move.
 */
const commitTree = (params: {
  readonly repo: Repo;
  readonly key: PrivateKey;
  readonly now: number;
  readonly state: RepoState;
}) =>
  Effect.gen(function* () {
    const encoded = yield* encodeTree(params.state.tree);
    const previous = yield* commitCid(params.repo.commit);
    const commit = yield* signCommit({
      did: params.repo.commit.did,
      data: encoded.root,
      rev: nextTid({
        previous: params.repo.commit.rev,
        now: params.now,
        clockId: tidClockId(params.repo.commit.rev),
      }),
      previous,
      key: params.key,
    });

    return {
      commit,
      tree: params.state.tree,
      records: recordsOf(params.state),
    };
  });

/** Apply one write to a tree, without committing. */
const applyWrite = (params: {
  readonly state: RepoState;
  readonly write: RepoWrite;
}) =>
  Effect.gen(function* () {
    const key = recordKey(params.write);

    if (params.write.action === 'delete') {
      // Deleting something absent is a failure rather than a no-op: a batch
      // that quietly did nothing is a batch nobody can debug.
      const tree = yield* removeLeaf({ node: params.state.tree, key });
      return { tree, records: params.state.records };
    }

    const block = yield* blockOfRecord(params.write.record);
    const tree = yield* setLeaf({
      tree: params.state.tree,
      key,
      value: block.cid,
    });
    const records = new Map(params.state.records);
    records.set(formatCid(block.cid), block);

    return { tree, records };
  });

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** A new, empty repository: one commit over an empty tree. */
export const createRepo = (params: {
  readonly did: string;
  readonly key: PrivateKey;
  readonly clockId: number;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const tree = emptyTree();
    const encoded = yield* encodeTree(tree);
    const commit = yield* signCommit({
      did: params.did,
      data: encoded.root,
      rev: nextTid({
        previous: undefined,
        now: params.now,
        clockId: params.clockId,
      }),
      previous: undefined,
      key: params.key,
    });

    return {
      commit,
      tree,
      records: new Map<string, Block>(),
    } satisfies Repo;
  }).pipe(
    Effect.withSpan('repo.createRepo', {
      attributes: { 'repo.did': params.did },
    }),
  );

/** Apply writes atomically: one tree, one revision, one commit. */
export const applyWrites = (params: {
  readonly repo: Repo;
  readonly writes: readonly RepoWrite[];
  readonly key: PrivateKey;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const state = yield* Effect.reduce(
      params.writes,
      () => ({ tree: params.repo.tree, records: params.repo.records }),
      (accumulated, write) => applyWrite({ state: accumulated, write }),
    );

    return yield* commitTree({
      repo: params.repo,
      key: params.key,
      now: params.now,
      state,
    });
  }).pipe(
    Effect.withSpan('repo.applyWrites', {
      attributes: {
        'repo.did': params.repo.commit.did,
        'repo.writes': params.writes.length,
      },
    }),
  );

/** Put one record. Replacing an existing record is the same write. */
export const putRecord = (params: {
  readonly repo: Repo;
  readonly collection: string;
  readonly rkey: string;
  readonly record: CborValue;
  readonly key: PrivateKey;
  readonly now: number;
}) =>
  applyWrites({
    repo: params.repo,
    writes: [
      {
        action: 'create',
        collection: params.collection,
        rkey: params.rkey,
        record: params.record,
      },
    ],
    key: params.key,
    now: params.now,
  }).pipe(
    Effect.withSpan('repo.putRecord', {
      attributes: {
        'repo.collection': params.collection,
        'repo.rkey': params.rkey,
      },
    }),
  );

/** Delete one record. */
export const deleteRecord = (params: {
  readonly repo: Repo;
  readonly collection: string;
  readonly rkey: string;
  readonly key: PrivateKey;
  readonly now: number;
}) =>
  applyWrites({
    repo: params.repo,
    writes: [
      {
        action: 'delete',
        collection: params.collection,
        rkey: params.rkey,
      },
    ],
    key: params.key,
    now: params.now,
  }).pipe(
    Effect.withSpan('repo.deleteRecord', {
      attributes: {
        'repo.collection': params.collection,
        'repo.rkey': params.rkey,
      },
    }),
  );

/** A record, or undefined when the repository does not hold it. */
export const getRecord = (params: {
  readonly repo: Repo;
  readonly collection: string;
  readonly rkey: string;
}) => {
  const value = lookup({
    node: params.repo.tree,
    key: recordKey(params),
  });
  if (value === undefined) {
    return undefined;
  }

  const block = params.repo.records.get(formatCid(value));
  return block === undefined ? undefined : decodeCbor(block.bytes);
};

/** The CID of the block that holds a record, or undefined when it is absent. */
export const recordCid = (params: {
  readonly repo: Repo;
  readonly collection: string;
  readonly rkey: string;
}) => lookup({ node: params.repo.tree, key: recordKey(params) });

/** The leaves of one collection, in key order, after `after` and up to `limit`. */
export const listRecords = (params: {
  readonly repo: Repo;
  readonly collection?: string | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}) => {
  const prefix = params.collection === undefined ? '' : `${params.collection}/`;
  const afterKey =
    params.collection === undefined || params.after === undefined
      ? undefined
      : `${params.collection}/${params.after}`;

  return leaves(params.repo.tree)
    .filter((leaf) => leaf.key.startsWith(prefix))
    .filter((leaf) => afterKey === undefined || leaf.key > afterKey)
    .slice(0, params.limit ?? Number.MAX_SAFE_INTEGER);
};

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** What loading one node needs: its entries, its layer, and the block set. */
type LoadingNode = {
  readonly entries: readonly MstNodeEntry[];
  readonly layer: number;
  readonly blocks: BlockSet;
};

/** Load a tree from its blocks: children by CID, each layer below its parent. */
// Recursive, so TypeScript cannot infer the return type (TS7023); the
// annotation is required here, not stylistic.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
const loadNode = (params: LoadingNode): MstNode => {
  const entries: MstTreeEntry[] = [];

  params.entries.forEach((entry) => {
    if (entry instanceof MstLeaf) {
      entries.push(entry);
      return;
    }
    if (!(entry instanceof MstSubtree)) {
      throw new RepoReadError({
        message: 'a node entry is neither a leaf nor a subtree',
      });
    }

    const block = params.blocks.get(formatCid(entry.subtree));
    if (block === undefined) {
      throw new RepoReadError({
        message: `no block for the subtree ${formatCid(entry.subtree)}`,
      });
    }
    entries.push(
      new MstChild({
        node: loadNode({
          entries: deserializeNodeData(decodeNodeData(block.bytes)),
          layer: params.layer - 1,
          blocks: params.blocks,
        }),
      }),
    );
  });

  return { entries, layer: params.layer };
};

/**
 * A tree from its blocks. The blocks do not record their own layers, so the
 * root's comes from its first leaf's hash - the same rule the tree was built
 * with - and every layer below is one less.
 */
export const treeFromBlocks = (params: {
  readonly root: Cid;
  readonly blocks: BlockSet;
}) =>
  Effect.gen(function* () {
    const block = params.blocks.get(formatCid(params.root));
    if (block === undefined) {
      return yield* new RepoReadError({
        message: `no block for the tree root ${formatCid(params.root)}`,
      });
    }

    const entries = deserializeNodeData(decodeNodeData(block.bytes));
    // An empty tree is layer 0; a root with entries takes its layer from its
    // first leaf. A root with neither would not be a root this writer produces.
    const layer = entries.length === 0 ? 0 : yield* layerForEntries(entries);

    return loadNode({ entries, layer, blocks: params.blocks });
  }).pipe(
    Effect.withSpan('repo.treeFromBlocks', {
      attributes: { 'repo.root': formatCid(params.root) },
    }),
  );

/** Write a repository as a CAR: the commit, its tree's nodes, its records. */
export const carOf = (repo: Repo) =>
  Effect.gen(function* () {
    const tree = yield* encodeTree(repo.tree);
    const root = yield* commitCid(repo.commit);

    return encodeCar({
      roots: [root],
      blocks: [
        { cid: root, bytes: encodeCbor(repo.commit) },
        ...tree.blocks.values(),
        ...repo.records.values(),
      ],
    });
  }).pipe(
    Effect.withSpan('repo.carOf', {
      attributes: { 'repo.did': repo.commit.did },
    }),
  );

/** Read a repository: its commit, its tree, and the records the tree names. */
export const repoFromCar = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const car = yield* readCar(bytes);
    const [root] = car.roots;
    if (root === undefined) {
      return yield* new RepoReadError({ message: 'the CAR names no root' });
    }

    const block = car.blocks.get(formatCid(root));
    if (block === undefined) {
      return yield* new RepoReadError({
        message: `the CAR does not contain its root ${formatCid(root)}`,
      });
    }

    const commit = yield* Effect.try({
      try: () => decodeCommit(block.bytes),
      catch: (cause) =>
        new RepoReadError({
          message: `the root of this CAR is not a commit: ${String(cause)}`,
        }),
    });
    const tree = yield* treeFromBlocks({
      root: commit.data.cid,
      blocks: car.blocks,
    });

    return {
      commit,
      tree,
      records: recordsOf({ tree, records: car.blocks }),
    } satisfies Repo;
  }).pipe(Effect.withSpan('repo.repoFromCar'));

/** Verify a repository's commit with the key that should have signed it. */
export const verifyRepo = (params: {
  readonly repo: Repo;
  readonly key: PublicKey;
}) =>
  verifyCommit({ commit: params.repo.commit, key: params.key }).pipe(
    Effect.withSpan('repo.verifyRepo', {
      attributes: { 'repo.did': params.repo.commit.did },
    }),
  );
