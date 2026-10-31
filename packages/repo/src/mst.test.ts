import {
  CODEC_DAG_CBOR,
  type CborValue,
  type Cid,
  CidLink,
  cidFromBytes,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import { Effect, Result } from 'effect';
import {
  MstLeaf,
  type MstNodeEntry,
  MstSubtree,
  decodeNodeData,
  deserializeNodeData,
  layerForEntries,
  serializeNodeData,
} from './mst.js';
import {
  MstMutationError,
  type MstNode,
  addLeaf,
  addLeaves,
  emptyTree,
  encodeTree,
  leaves,
  lookup,
  removeLeaf,
} from './mst-tree.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sha256 } from '@eoa/crypto';

/**
 * A real repository, captured from a public PDS on 2026-09-24:
 *
 *   GET https://woodear.us-west.host.bsky.network/xrpc/com.atproto.sync.getRepo
 *       ?did=did:plc:pghz3kxikqowruq2wnj6kh2o
 *
 * 23 blocks: one commit, six MST nodes and sixteen records. Small, but it has
 * interior structure - two nodes with a left subtree, three entries with child
 * subtrees - which is where a wrong prefix length or link encoding shows up.
 * Its blocks are read with OUR decoder and re-derived with OUR encoder, so a
 * byte-level disagreement with the reference implementation fails here instead
 * of being hidden behind a shared dependency.
 */
const fixture = new Uint8Array(
  readFileSync(new URL('../fixtures/repo-sample.car', import.meta.url)),
);

const readVarint = (bytes: Uint8Array, offset: number) =>
  Array.from({ length: 10 }, (_unused, index) => index).reduce<{
    value: number;
    next: number;
    done: boolean;
  }>(
    (state, index) => {
      if (state.done) {
        return state;
      }
      const byte = bytes[offset + index] ?? 0;
      return {
        value: state.value + (byte & 0x7f) * 2 ** (7 * index),
        next: offset + index + 1,
        done: (byte & 0x80) === 0,
      };
    },
    { value: 0, next: offset, done: false },
  );

/** CARv1: a dag-cbor header, then `[len][cid][block]` for each block. */
const readCar = (bytes: Uint8Array) => {
  const headerField = readVarint(bytes, 0);
  const header = decodeCbor(
    bytes.slice(headerField.next, headerField.next + headerField.value),
  );
  const blocks = new Map<string, { cid: Cid; bytes: Uint8Array }>();
  const blocksStart = headerField.next + headerField.value;

  Array.from({ length: bytes.length }).reduce<number>((offset) => {
    if (offset >= bytes.length) {
      return offset;
    }
    const block = readVarint(bytes, offset);
    const afterLength = block.next;
    // Our CID reader wants exactly the CID, so its length comes from the
    // header: version, codec, hash code, digest length.
    const cidLength = 4 + (bytes[afterLength + 3] ?? 0);
    const cid = cidFromBytes(bytes.slice(afterLength, afterLength + cidLength));
    if (Result.isFailure(cid)) {
      return bytes.length;
    }
    blocks.set(formatCid(cid.success), {
      cid: cid.success,
      bytes: bytes.slice(afterLength + cidLength, afterLength + block.value),
    });
    return afterLength + block.value;
  }, blocksStart);

  return { header, blocks };
};

const isNode = (value: CborValue) =>
  typeof value === 'object' && value !== null && 'e' in value && 'l' in value;

const entriesOf = (
  blocks: ReadonlyMap<string, { bytes: Uint8Array }>,
  cid: Cid,
) => {
  const block = blocks.get(formatCid(cid));
  return block === undefined
    ? []
    : deserializeNodeData(decodeNodeData(block.bytes));
};

const childLinks = (entries: readonly MstNodeEntry[]) =>
  entries.flatMap((entry) =>
    entry instanceof MstSubtree ? [entry.subtree] : [],
  );

/** Walks the tree from its root by following `l` and `t` links only. */
const walk = (params: {
  readonly root: Cid;
  readonly blocks: ReadonlyMap<string, { bytes: Uint8Array }>;
}) => {
  const visited = new Set([formatCid(params.root)]);
  const rootEntries = entriesOf(params.blocks, params.root);
  const nodes = [{ entries: rootEntries, depth: 0 }];

  // Level by level; the frontier is empty long before the bound.
  Array.from({ length: 64 }).reduce<readonly { cid: Cid; depth: number }[]>(
    (frontier, _unused) => {
      const next: { cid: Cid; depth: number }[] = [];
      frontier.forEach((current) => {
        childLinks(entriesOf(params.blocks, current.cid)).forEach((child) => {
          const key = formatCid(child);
          if (visited.has(key)) {
            return;
          }
          visited.add(key);
          nodes.push({
            entries: entriesOf(params.blocks, child),
            depth: current.depth + 1,
          });
          next.push({ cid: child, depth: current.depth + 1 });
        });
      });
      return next;
    },
    [{ cid: params.root, depth: 0 }],
  );

  return { nodes, rootEntries };
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const car = readCar(fixture);
const blocks = [...car.blocks.entries()];
const rootCid = readRoot(car.header);
const commit =
  rootCid === undefined ? undefined : car.blocks.get(formatCid(rootCid));

describe('a real repository CAR', () => {
  it('decodes with our own decoder', () => {
    expect(car.header).toMatchObject({ version: 1 });
    expect(blocks).toHaveLength(23);
    expect(commit).toBeDefined();
    expect(isNode(decodeCbor(commit?.bytes ?? new Uint8Array()))).toBe(false);
  });

  it('re-encodes every block to the CID it came with', async () => {
    const derived = await Effect.runPromise(
      Effect.forEach(blocks, ([cid, block]) =>
        Effect.gen(function* () {
          const bytes = encodeCbor(decodeCbor(block.bytes));
          const digest = yield* sha256(bytes);
          return {
            cid,
            matches:
              formatCid(cidFromDigest({ codec: CODEC_DAG_CBOR, digest })) ===
              cid,
            canonical: sameBytes(bytes, block.bytes),
          };
        }),
      ),
    );

    expect(derived).toHaveLength(23);
    expect(
      derived.filter((entry) => !entry.matches).map((entry) => entry.cid),
    ).toEqual([]);
    // Re-encoding produced the same bytes, so the fixture is canonical too.
    expect(
      derived.filter((entry) => !entry.canonical).map((entry) => entry.cid),
    ).toEqual([]);
  });

  it('round-trips every MST node byte for byte', () => {
    const nodes = blocks.filter(([, block]) => isNode(decodeCbor(block.bytes)));
    expect(nodes).toHaveLength(6);

    const results = nodes.map(([cid, block]) => {
      const entries = deserializeNodeData(decodeNodeData(block.bytes));
      return {
        cid,
        rebuilt: encodeCbor(serializeNodeData(entries)),
        original: block.bytes,
        entries,
      };
    });

    expect(
      results.filter((result) => !sameBytes(result.rebuilt, result.original)),
    ).toEqual([]);
    // Every key it holds is a `<collection>/<rkey>` leaf.
    expect(
      results
        .flatMap((result) => result.entries)
        .filter((entry) => entry instanceof MstLeaf)
        .every((leaf) => leaf.key.includes('/')),
    ).toBe(true);
  });

  it('walks from the commit to every node, following only links', () => {
    const root = readLink(commit?.bytes, 'data');
    expect(root).toBeDefined();

    const walked = walk({ root: root as Cid, blocks: car.blocks });

    expect(walked.nodes).toHaveLength(6);
    expect(
      walked.nodes.filter((node) => node.depth > 0).length,
    ).toBeGreaterThan(0);
  });

  it('agrees with the reference on the layer rule', async () => {
    const root = readLink(commit?.bytes, 'data') as Cid;
    const walked = walk({ root, blocks: car.blocks });

    // The root's layer is its first leaf's, and every node below sits exactly
    // one layer lower - which is what the hash rule has to produce for the tree
    // to have been built at all.
    const layers = await Effect.runPromise(
      Effect.forEach(walked.nodes, (node) =>
        layerForEntries(node.entries).pipe(
          Effect.map((layer) => ({ layer, depth: node.depth })),
        ),
      ),
    );
    const rootLayer = layers.find((entry) => entry.depth === 0)?.layer;

    expect(rootLayer).toBeGreaterThan(0);
    expect(
      layers.filter((entry) => entry.layer !== (rootLayer ?? 0) - entry.depth),
    ).toEqual([]);
  });
});

function readRoot(header: CborValue) {
  if (
    typeof header !== 'object' ||
    header === null ||
    Array.isArray(header) ||
    header instanceof CidLink ||
    header instanceof Uint8Array
  ) {
    return undefined;
  }
  const roots = header['roots'];
  if (!Array.isArray(roots)) {
    return undefined;
  }
  const [first] = roots;
  return first instanceof CidLink ? first.cid : undefined;
}

function readLink(bytes: Uint8Array | undefined, key: string) {
  if (bytes === undefined) {
    return undefined;
  }
  const value = decodeCbor(bytes);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (value instanceof CidLink || value instanceof Uint8Array) {
    return undefined;
  }
  const link = value[key];
  return link instanceof CidLink ? link.cid : undefined;
}

/**
 * The leaves the real tree holds, as `key -> value`: what a rebuild starts
 * from. Taken from the fixture's own nodes, so the test does not carry a second
 * copy of the data that could drift from the first.
 */
const fixtureLeaves = blocks.flatMap(([, block]) => {
  const value = decodeCbor(block.bytes);
  return isNode(value)
    ? deserializeNodeData(decodeNodeData(block.bytes)).flatMap((entry) =>
        entry instanceof MstLeaf ? [entry] : [],
      )
    : [];
});

const realRoot = readLink(commit?.bytes, 'data');

/** The CIDs of the fixture's own MST nodes, in a stable order. */
const realNodeCids = blocks
  .flatMap(([cid, block]) => (isNode(decodeCbor(block.bytes)) ? [cid] : []))
  .sort();

const cidsOf = (tree: MstNode) =>
  Effect.map(encodeTree(tree), (encoded) => ({
    root: encoded.root,
    cids: [...encoded.blocks.keys()].sort(),
  }));

const buildTree = (order: readonly MstLeaf[]) =>
  Effect.runPromise(addLeaves({ node: emptyTree(), leaves: order }));

describe('building the tree from its leaves', () => {
  it('collects the fixture leaves', () => {
    expect(fixtureLeaves).toHaveLength(16);
    expect(new Set(fixtureLeaves.map((leaf) => leaf.key)).size).toBe(16);
    expect(realRoot).toBeDefined();
  });

  it('rebuilds the real root CID and every real node CID, in any order', async () => {
    const expectedRoot =
      realRoot === undefined ? 'no root in the fixture' : formatCid(realRoot);
    const orders = [
      fixtureLeaves,
      [...fixtureLeaves].reverse(),
      // Interleaved: insertion order must not matter, because a key's layer is
      // a property of its hash, not of when it arrived.
      fixtureLeaves
        .filter((_unused, index) => index % 2 === 0)
        .concat(fixtureLeaves.filter((_unused, index) => index % 2 === 1)),
    ];

    for (const order of orders) {
      const encoded = await Effect.runPromise(cidsOf(await buildTree(order)));

      expect(formatCid(encoded.root)).toBe(expectedRoot);
      // Not only the root: the whole node set has to match, so the splits and
      // the layers agree with the reference and not merely the total.
      expect(encoded.cids).toEqual(realNodeCids);
    }
  });

  it('puts every node at the layer its first leaf implies', async () => {
    const encoded = await Effect.runPromise(
      encodeTree(await buildTree(fixtureLeaves)),
    );

    // The same walk the real tree is held to, so a tree we built is checked
    // against the rule the reference's tree actually satisfies.
    const walked = walk({ root: encoded.root, blocks: encoded.blocks });
    const layers = await Effect.runPromise(
      Effect.forEach(walked.nodes, (node) =>
        layerForEntries(node.entries).pipe(
          Effect.map((layer) => ({ layer, depth: node.depth })),
        ),
      ),
    );
    const rootLayer = layers.find((entry) => entry.depth === 0)?.layer;

    expect(layers).toHaveLength(6);
    expect(
      layers.filter((entry) => entry.layer !== (rootLayer ?? 0) - entry.depth),
    ).toEqual([]);
  });

  it('removes a leaf and keeps every other one reachable', async () => {
    const tree = await buildTree(fixtureLeaves);
    const [first] = fixtureLeaves;
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    const without = await Effect.runPromise(
      removeLeaf({ node: tree, key: first.key }),
    );
    const remaining = fixtureLeaves
      .flatMap((leaf: MstLeaf) => (leaf.key === first.key ? [] : [leaf.key]))
      .sort();

    expect(lookup({ node: without, key: first.key })).toBeUndefined();
    expect(leaves(without).map((leaf) => leaf.key)).toEqual(remaining);
    expect(
      remaining.filter((key) => lookup({ node: without, key }) === undefined),
    ).toEqual([]);
  });

  it('returns the same tree when a deleted leaf is added back, for every leaf', async () => {
    const tree = await buildTree(fixtureLeaves);
    const before = await Effect.runPromise(cidsOf(tree));

    const results = await Effect.runPromise(
      Effect.forEach(fixtureLeaves, (leaf) =>
        Effect.gen(function* () {
          const without = yield* removeLeaf({ node: tree, key: leaf.key });
          const restored = yield* addLeaf({
            node: without,
            key: leaf.key,
            value: leaf.value,
          });
          const after = yield* cidsOf(restored);

          return {
            key: leaf.key,
            same:
              formatCid(after.root) === formatCid(before.root) &&
              after.cids.join(',') === before.cids.join(','),
          };
        }),
      ),
    );

    expect(results.filter((result) => !result.same)).toEqual([]);
  });

  it('empties, and is rebuilt identically, when every leaf is removed', async () => {
    const tree = await buildTree(fixtureLeaves);
    const before = await Effect.runPromise(cidsOf(tree));

    const emptied = await Effect.runPromise(
      Effect.reduce(
        fixtureLeaves,
        () => tree,
        (node, leaf) => removeLeaf({ node, key: leaf.key }),
      ),
    );
    expect(emptied.entries).toHaveLength(0);

    const rebuilt = await Effect.runPromise(
      cidsOf(await buildTree(fixtureLeaves)),
    );
    expect(rebuilt.cids).toEqual(before.cids);
  });

  it('refuses a duplicate key, a missing key and an invalid key', async () => {
    const tree = await buildTree(fixtureLeaves);
    const [first] = fixtureLeaves;
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    // A duplicate is a failure rather than a replace, and a missing key a
    // failure rather than a silent no-op: both would lose data quietly.
    await expect(
      Effect.runPromise(
        addLeaf({ node: tree, key: first.key, value: first.value }),
      ),
    ).rejects.toThrow(MstMutationError);
    await expect(
      Effect.runPromise(
        removeLeaf({ node: tree, key: 'app.bsky.feed.post/nothing' }),
      ),
    ).rejects.toThrow(MstMutationError);
    await expect(
      Effect.runPromise(
        addLeaf({ node: tree, key: 'not-a-valid-key', value: first.value }),
      ),
    ).rejects.toThrow(MstMutationError);
  });
});
