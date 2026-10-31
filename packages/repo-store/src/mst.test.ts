import { CODEC_DAG_CBOR, type Cid, formatCid } from '@eoa/core';
import {
  MstLeaf,
  type MstNodeEntry,
  MstSubtree,
  countPrefixLen,
  decodeNodeData,
  deserializeNodeData,
  encodeNode,
  isValidMstKey,
  layerForEntries,
  leadingZerosOnHash,
} from './mst.js';
import {
  addLeaf,
  addLeaves,
  emptyTree,
  encodeTree,
  leaves,
  lookup,
  removeLeaf,
} from './mst-tree.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { decodeCommit } from './commit.js';
import { readFixture } from './fixture.js';

/**
 * The acceptance is a **real repository**, not our own encoder: the fixture is
 * a repo captured from a public PDS, read here with our decoder and re-derived
 * with our encoder, so a byte-level disagreement with the reference fails here
 * rather than being hidden behind a shared dependency.
 */
const { roots, blocks } = readFixture();

const firstRoot = roots[0];
if (firstRoot === undefined) {
  throw new Error('the fixture CAR has no root');
}

const blockFor = (cid: Cid) => {
  const block = blocks.get(formatCid(cid));
  if (block === undefined) {
    throw new Error(`the fixture has no block for ${formatCid(cid)}`);
  }
  return block;
};

/** The MST root the fixture's commit points at. */
const treeRoot = decodeCommit(blockFor(firstRoot).bytes).data.cid;

interface FixtureNode {
  readonly cid: Cid;
  readonly entries: ReadonlyArray<MstNodeEntry>;
}

/** Every MST node reachable from a CID, with the entries it holds. */
const nodesUnder = (cid: Cid, found: FixtureNode[] = []) => {
  const entries = deserializeNodeData(decodeNodeData(blockFor(cid).bytes));
  found.push({ cid, entries });
  for (const entry of entries) {
    if (entry instanceof MstSubtree) {
      nodesUnder(entry.subtree, found);
    }
  }
  return found;
};

/** Every leaf of the fixture's tree, in key order. */
const fixtureLeaves = (cid: Cid, found: MstLeaf[] = []) => {
  for (const entry of deserializeNodeData(
    decodeNodeData(blockFor(cid).bytes),
  )) {
    if (entry instanceof MstLeaf) {
      found.push(entry);
    } else {
      fixtureLeaves(entry.subtree, found);
    }
  }
  return found;
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('the MST against a real repository', () => {
  it('re-encodes every node of a captured repo to the same CID', async () => {
    const nodes = nodesUnder(treeRoot);
    expect(nodes.length).toBeGreaterThan(1);

    const same = await run(
      Effect.forEach(nodes, (node) =>
        encodeNode(node.entries).pipe(
          Effect.map(
            (encoded) => formatCid(encoded.cid) === formatCid(node.cid),
          ),
        ),
      ),
    );

    expect(same).toEqual(nodes.map(() => true));
  });

  it('rebuilds the repo root from its leaves', async () => {
    const found = fixtureLeaves(treeRoot);
    expect(found.length).toBeGreaterThan(0);

    const rebuilt = await run(
      Effect.gen(function* () {
        const tree = yield* addLeaves({ node: emptyTree(), leaves: found });
        return yield* encodeTree(tree);
      }),
    );

    expect(formatCid(rebuilt.root)).toBe(formatCid(treeRoot));
    expect(rebuilt.blocks.size).toBe(nodesUnder(treeRoot).length);
  });

  it('finds every leaf it was built from', async () => {
    const found = fixtureLeaves(treeRoot);
    const rebuilt = await run(addLeaves({ node: emptyTree(), leaves: found }));

    for (const leaf of found) {
      expect(lookup({ node: rebuilt, key: leaf.key })).toEqual(leaf.value);
    }
    expect(leaves(rebuilt)).toHaveLength(found.length);
  });
});

describe('the MST rules', () => {
  const cid = (seed: number) => ({
    version: 1 as const,
    codec: CODEC_DAG_CBOR,
    digest: new Uint8Array(32).fill(seed),
  });

  it('gives a key the layer of the leading zero bits of its hash', async () => {
    const zeros = await run(leadingZerosOnHash('app.bsky.feed.post/a'));
    expect(zeros).toBeGreaterThanOrEqual(0);

    const layer = await run(
      layerForEntries([
        new MstSubtree({ subtree: cid(1) }),
        new MstLeaf({ key: 'app.bsky.feed.post/a', value: cid(2) }),
      ]),
    );
    expect(layer).toBe(zeros);
  });

  it('measures a prefix against the previous key in the node', () => {
    expect(countPrefixLen('app.bsky.feed.post/a', 'app.bsky.feed.post/b')).toBe(
      19,
    );
    expect(countPrefixLen('', 'anything')).toBe(0);
  });

  it('accepts only collection/rkey keys', () => {
    expect(isValidMstKey('app.bsky.feed.post/abc')).toBe(true);
    expect(isValidMstKey('app.bsky.feed.post')).toBe(false);
    expect(isValidMstKey('app.bsky.feed.post/')).toBe(false);
    expect(isValidMstKey('app.bsky.feed.post/a/b')).toBe(false);
  });

  it('adds and removes without disturbing the rest', async () => {
    const result = await run(
      Effect.gen(function* () {
        const keys = [
          'app.bsky.feed.post/a',
          'app.bsky.feed.post/b',
          'app.bsky.feed.post/c',
        ];
        const withAll = yield* addLeaves({
          node: emptyTree(),
          leaves: keys.map(
            (key, index) => new MstLeaf({ key, value: cid(index) }),
          ),
        });
        const withoutB = yield* removeLeaf({
          node: withAll,
          key: 'app.bsky.feed.post/b',
        });
        return {
          kept: leaves(withoutB).map((leaf) => leaf.key),
          gone: lookup({ node: withoutB, key: 'app.bsky.feed.post/b' }),
          stillThere: lookup({ node: withoutB, key: 'app.bsky.feed.post/c' }),
        };
      }),
    );

    expect(result.kept).toEqual([
      'app.bsky.feed.post/a',
      'app.bsky.feed.post/c',
    ]);
    expect(result.gone).toBeUndefined();
    expect(result.stillThere).toEqual(cid(2));
  });

  it('refuses a key that is already there, and one that is not', async () => {
    const key = 'app.bsky.feed.post/a';

    const result = await run(
      Effect.gen(function* () {
        const tree = yield* addLeaf({ node: emptyTree(), key, value: cid(1) });
        const twice = yield* Effect.flip(
          addLeaf({ node: tree, key, value: cid(1) }),
        );
        const missing = yield* Effect.flip(
          removeLeaf({ node: tree, key: 'app.bsky.feed.post/zzz' }),
        );
        return { twice, missing };
      }),
    );

    expect(result.twice._tag).toBe('MstMutationError');
    expect(result.missing._tag).toBe('MstMutationError');
  });
});
