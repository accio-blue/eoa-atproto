import { type Cid, formatCid } from '@eoa/core';
import { Data, Effect, Schema } from 'effect';
import {
  MstLeaf,
  type MstNodeEntry,
  MstSubtree,
  encodeNode,
  isValidMstKey,
  leadingZerosOnHash,
} from './mst.js';
import type { CryptoError } from '@eoa/crypto';

/**
 * The MST as it is *built*.
 *
 * `mst.ts` covers the node: what a node is, and how it becomes bytes and a CID.
 * This is the tree — insert, look up, delete, and the blocks a tree is made of.
 * The rules are the reference's (`bluesky-social/atproto`,
 * `packages/repo/src/mst/mst.ts`), and the acceptance test rebuilds a real
 * repository from its leaves and compares root CIDs rather than reasoning about
 * them.
 *
 * Two differences from the reference, both because this tree lives in memory
 * rather than behind a block store: a child holds its node rather than the CID
 * of its block, so nothing is read or written while a tree is mutated; and every
 * node carries its layer, where the reference carries a hint it may have to
 * resolve by loading children. The second is why almost nothing here returns an
 * Effect — only the entry points that hash a key are effectful, and the
 * recursion is pure.
 */

/** Reported when a mutation cannot be applied. */
export class MstMutationError extends Schema.TaggedError<MstMutationError>()(
  'MstMutationError',
  { message: Schema.String },
) {}

/** A tree in memory: its entries, and the layer it sits at. */
export interface MstNode {
  readonly entries: ReadonlyArray<MstTreeEntry>;
  readonly layer: number;
}

/** A child in memory: the node itself, not a link to its block. */
export class MstChild extends Data.TaggedClass('MstChild')<{
  readonly node: MstNode;
}> {}

export type MstTreeEntry = MstLeaf | MstChild;

/** What an insertion needs to know about its key. */
interface Insertion {
  readonly key: string;
  readonly value: Cid;
  /** The leading zero bits of the key's hash: the layer it belongs at. */
  readonly zeros: number;
}

/** A block: its bytes, and the CID they hash to. */
export interface Block {
  readonly cid: Cid;
  readonly bytes: Uint8Array;
}

/** Blocks keyed by CID — what a reader indexes and what a CAR carries. */
export type BlockSet = Map<string, Block>;

/** An empty tree, at the layer the reference gives one. */
export const emptyTree = () => ({ entries: [], layer: 0 });

/** The first leaf at or after `key`; the length when there is none. */
const findGtOrEqualLeafIndex = (
  entries: ReadonlyArray<MstTreeEntry>,
  key: string,
) => {
  const index = entries.findIndex(
    (entry) => entry instanceof MstLeaf && entry.key >= key,
  );
  return index >= 0 ? index : entries.length;
};

/**
 * The value at `key`, or undefined when no leaf holds it. At most one entry can
 * hold the key, and when the entries before it are a subtree, that subtree is
 * where it would be.
 */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function findLeaf(node: MstNode, key: string): Cid | undefined {
  const index = findGtOrEqualLeafIndex(node.entries, key);
  const found = node.entries[index];
  if (found instanceof MstLeaf && found.key === key) {
    return found.value;
  }
  const previous = node.entries[index - 1];
  return previous instanceof MstChild
    ? findLeaf(previous.node, key)
    : undefined;
}

/** Every leaf, in key order. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
export function leaves(node: MstNode): MstLeaf[] {
  return node.entries.flatMap((entry) =>
    entry instanceof MstLeaf ? [entry] : leaves(entry.node),
  );
}

/** A node with the same layer and different entries: mutations return nodes. */
const nodeWith = (node: MstNode, entries: ReadonlyArray<MstTreeEntry>) => ({
  entries,
  layer: node.layer,
});

/** An empty node one layer below. */
const createChild = (node: MstNode) => ({
  entries: [],
  layer: node.layer - 1,
});

/** A node one layer above, holding `child` and nothing else. */
const createParent = (child: MstNode) => ({
  entries: [new MstChild({ node: child })],
  layer: child.layer + 1,
});

/** Climb `times` layers, wrapping the node in a parent each time. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function wrapInParents(node: MstNode | null, times: number): MstNode | null {
  if (node === null || times <= 0) {
    return node;
  }
  return wrapInParents(createParent(node), times - 1);
}

/** The two halves of a node, either of which may be empty. */
interface Split {
  readonly left: MstNode | null;
  readonly right: MstNode | null;
}

/**
 * Split a node around `key`: the entries sorting before it, and the rest. A
 * subtree straddling the key is split too, so both halves stay valid.
 */
// Recursive (a straddling subtree splits too), so TS7023.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function splitAround(node: MstNode, key: string): Split {
  const index = findGtOrEqualLeafIndex(node.entries, key);
  const leftEntries = node.entries.slice(0, index);
  const rightEntries = node.entries.slice(index);
  const lastInLeft = leftEntries[leftEntries.length - 1];

  if (!(lastInLeft instanceof MstChild)) {
    return {
      left: leftEntries.length > 0 ? nodeWith(node, leftEntries) : null,
      right: rightEntries.length > 0 ? nodeWith(node, rightEntries) : null,
    };
  }

  // The far side of the left half is a subtree, and the key may fall inside it.
  const split = splitAround(lastInLeft.node, key);
  const left = [
    ...leftEntries.slice(0, -1),
    ...(split.left === null ? [] : [new MstChild({ node: split.left })]),
  ];
  const right = [
    ...(split.right === null ? [] : [new MstChild({ node: split.right })]),
    ...rightEntries,
  ];

  return {
    left: left.length > 0 ? nodeWith(node, left) : null,
    right: right.length > 0 ? nodeWith(node, right) : null,
  };
}

/** Insert a leaf, returning the node that holds it. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function insertLeaf(node: MstNode, insertion: Insertion): MstNode {
  const leaf = new MstLeaf({ key: insertion.key, value: insertion.value });

  if (insertion.zeros === node.layer) {
    const index = findGtOrEqualLeafIndex(node.entries, insertion.key);
    const found = node.entries[index];
    if (found instanceof MstLeaf && found.key === insertion.key) {
      throw new MstMutationError({
        message: `there is already a leaf at key: ${insertion.key}`,
      });
    }

    const previous = node.entries[index - 1];
    if (!(previous instanceof MstChild)) {
      return nodeWith(node, [
        ...node.entries.slice(0, index),
        leaf,
        ...node.entries.slice(index),
      ]);
    }

    // The subtree before the key spans it, so it has to be split in two. The
    // entry at `index` is the leaf sorting at or after the key, and it stays:
    // only the subtree before the key is replaced.
    const split = splitAround(previous.node, insertion.key);
    return nodeWith(node, [
      ...node.entries.slice(0, index - 1),
      ...(split.left === null ? [] : [new MstChild({ node: split.left })]),
      leaf,
      ...(split.right === null ? [] : [new MstChild({ node: split.right })]),
      ...node.entries.slice(index),
    ]);
  }

  if (insertion.zeros < node.layer) {
    // The key belongs below: follow the subtree it would fall in, or start one.
    const index = findGtOrEqualLeafIndex(node.entries, insertion.key);
    const previous = node.entries[index - 1];
    const replacing = previous instanceof MstChild;
    const child = insertLeaf(
      replacing ? previous.node : createChild(node),
      insertion,
    );
    const at = replacing ? index - 1 : index;

    return nodeWith(node, [
      ...node.entries.slice(0, at),
      new MstChild({ node: child }),
      ...node.entries.slice(replacing ? at + 1 : at),
    ]);
  }

  // The key belongs above this node, so the node becomes one of its children —
  // and every layer the key skips needs a node to hold the path.
  const split = splitAround(node, insertion.key);
  const lift = insertion.zeros - node.layer - 1;
  const left = wrapInParents(split.left, lift);
  const right = wrapInParents(split.right, lift);

  return {
    layer: insertion.zeros,
    entries: [
      ...(left === null ? [] : [new MstChild({ node: left })]),
      leaf,
      ...(right === null ? [] : [new MstChild({ node: right })]),
    ],
  };
}

/**
 * Merge the right node into the left. Only valid when every key in the right
 * sorts after every key in the left — exactly what a deletion creates when it
 * removes the leaf that separated two subtrees.
 */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function appendMerge(node: MstNode, toMerge: MstNode): MstNode {
  if (node.layer !== toMerge.layer) {
    throw new MstMutationError({
      message: `cannot merge nodes from layers ${node.layer} and ${toMerge.layer}`,
    });
  }

  const lastInLeft = node.entries[node.entries.length - 1];
  const firstInRight = toMerge.entries[0];
  if (lastInLeft instanceof MstChild && firstInRight instanceof MstChild) {
    return nodeWith(node, [
      ...node.entries.slice(0, -1),
      new MstChild({ node: appendMerge(lastInLeft.node, firstInRight.node) }),
      ...toMerge.entries.slice(1),
    ]);
  }

  return nodeWith(node, [...node.entries, ...toMerge.entries]);
}

/** Delete the leaf at `key`, merging the subtrees it was separating. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function deleteRecurse(node: MstNode, key: string): MstNode {
  const index = findGtOrEqualLeafIndex(node.entries, key);
  const found = node.entries[index];

  if (found instanceof MstLeaf && found.key === key) {
    const previous = node.entries[index - 1];
    const next = node.entries[index + 1];
    if (previous instanceof MstChild && next instanceof MstChild) {
      // Both neighbours are subtrees: with the leaf gone they are adjacent, and
      // every key in the left sorts before every key in the right.
      return nodeWith(node, [
        ...node.entries.slice(0, index - 1),
        new MstChild({ node: appendMerge(previous.node, next.node) }),
        ...node.entries.slice(index + 2),
      ]);
    }
    return nodeWith(node, [
      ...node.entries.slice(0, index),
      ...node.entries.slice(index + 1),
    ]);
  }

  const previous = node.entries[index - 1];
  if (!(previous instanceof MstChild)) {
    throw new MstMutationError({
      message: `could not find a leaf at key: ${key}`,
    });
  }

  const subtree = deleteRecurse(previous.node, key);
  return nodeWith(node, [
    ...node.entries.slice(0, index - 1),
    // A subtree that emptied out has nothing left to point at.
    ...(subtree.entries.length === 0 ? [] : [new MstChild({ node: subtree })]),
    ...node.entries.slice(index),
  ]);
}

/** A root that adds nothing is trimmed: a node holding only a child is that child. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function trimTop(node: MstNode): MstNode {
  const only = node.entries[0];
  return node.entries.length === 1 && only instanceof MstChild
    ? trimTop(only.node)
    : node;
}

/**
 * Run a mutation, turning what it throws into a failure in the Effect channel.
 * The mutations throw because they are pure and recursive, and a mutation that
 * cannot be applied is an ordinary outcome — a key already present, a key
 * absent — rather than a defect.
 */
const attemptMutation = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof MstMutationError
        ? cause
        : new MstMutationError({ message: String(cause) }),
  });

/** The value at `key`, or undefined when no leaf holds it. */
export const lookup = (params: {
  readonly node: MstNode;
  readonly key: string;
}) => findLeaf(params.node, params.key);

/** Insert a leaf. A key that is already present is a failure, not a replace. */
export const addLeaf = (params: {
  readonly node: MstNode;
  readonly key: string;
  readonly value: Cid;
}) =>
  Effect.gen(function* () {
    if (!isValidMstKey(params.key)) {
      return yield* new MstMutationError({
        message: `not a valid MST key: ${params.key}`,
      });
    }
    const zeros = yield* leadingZerosOnHash(params.key);
    return yield* attemptMutation(() =>
      insertLeaf(params.node, { key: params.key, value: params.value, zeros }),
    );
  });

/** Insert many leaves. The tree's shape is fixed by the keys, not the order. */
export const addLeaves = (params: {
  readonly node: MstNode;
  readonly leaves: ReadonlyArray<MstLeaf>;
}) =>
  Effect.reduce(
    params.leaves,
    () => params.node,
    (node, leaf) => addLeaf({ node, key: leaf.key, value: leaf.value }),
  );

/** Remove the leaf at `key`. A key that is absent is a failure. */
export const removeLeaf = (params: {
  readonly node: MstNode;
  readonly key: string;
}) => attemptMutation(() => trimTop(deleteRecurse(params.node, params.key)));

/** What encoding one node yields: the CID of the block it wrote. */
type NodeCid = Effect.Effect<Cid, CryptoError>;

/**
 * Post-order, so a child's CID is known before the node that links to it is
 * encoded. `blocks` fills as a side effect of the walk: the same tree produces
 * the same blocks, whatever order they were visited in.
 */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function encodeNodeInto(blocks: BlockSet, node: MstNode): NodeCid {
  return Effect.gen(function* () {
    const entries: Array<MstNodeEntry> = [];
    for (const entry of node.entries) {
      if (entry instanceof MstChild) {
        const child = yield* encodeNodeInto(blocks, entry.node);
        entries.push(new MstSubtree({ subtree: child }));
      } else {
        entries.push(entry);
      }
    }

    const block = yield* encodeNode(entries);
    blocks.set(formatCid(block.cid), block);
    return block.cid;
  });
}

/** A tree's blocks: its root CID, and every node's bytes keyed by CID. */
export const encodeTree = (node: MstNode) =>
  Effect.gen(function* () {
    const blocks: BlockSet = new Map();
    const root = yield* encodeNodeInto(blocks, node);
    return { root, blocks };
  });
