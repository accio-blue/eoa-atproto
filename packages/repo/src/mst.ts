import {
  CODEC_DAG_CBOR,
  type Cid,
  CidLink,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
} from '@eoa/core';
import { Data, Effect, Schema } from 'effect';
import { sha256 } from '@eoa/crypto';

/**
 * The Merkle Search Tree, in the shape a repo writes it.
 *
 * This is the node half: how a node's contents become DAG-CBOR bytes and a CID.
 * It is the part where a mistake is *silent* — a wrong layer or prefix length
 * still round-trips locally, but produces a different root CID, and a repo
 * whose root CID disagrees with the bytes is unreadable to every other atproto
 * implementation. So the rules are ported from the reference
 * (`bluesky-social/atproto`, `packages/repo/src/mst`) and checked against real
 * repo blocks, not against our own encoder.
 *
 * Mutation (insert/delete) is the next slice; it builds on this.
 */

/** Reported when a node's contents are not a valid MST node. */
export class InvalidMstNodeError extends Schema.TaggedError<InvalidMstNodeError>()(
  'InvalidMstNodeError',
  {
    message: Schema.String,
  },
) {}

/** A leaf: a record's key, and the CID of the block that holds it. */
export class MstLeaf extends Data.TaggedClass('MstLeaf')<{
  readonly key: string;
  readonly value: Cid;
}> {}

/** A subtree hanging off a node. */
export class MstSubtree extends Data.TaggedClass('MstSubtree')<{
  readonly subtree: Cid;
}> {}

export type MstNodeEntry = MstLeaf | MstSubtree;

/**
 * A node as it is written: `l` is the subtree holding keys before the first
 * entry, and `e` the entries. `t` is always present - `null`, never omitted -
 * and `k` is a byte string, because that is what the reference emits and the
 * CID covers the bytes.
 */
export type MstNodeData = {
  l: CidLink | null;
  e: {
    p: number;
    k: Uint8Array;
    v: CidLink;
    t: CidLink | null;
  }[];
};

const TEXT_ENCODER = new TextEncoder();

/** A key is `<collection>/<rkey>`: ASCII, one slash, and never empty. */
const MAX_KEY_LENGTH = 1024;
const VALID_KEY_CHARS = /^[a-zA-Z0-9_~\-:.]*$/;

export const isValidMstKey = (key: string) => {
  const parts = key.split('/');
  const [collection, rkey] = parts;
  return (
    key.length <= MAX_KEY_LENGTH &&
    parts.length === 2 &&
    collection !== undefined &&
    collection.length > 0 &&
    VALID_KEY_CHARS.test(collection) &&
    rkey !== undefined &&
    rkey.length > 0 &&
    VALID_KEY_CHARS.test(rkey)
  );
};

const ensureValidMstKey = (key: string) => {
  if (!isValidMstKey(key)) {
    throw new InvalidMstNodeError({ message: `not a valid MST key: ${key}` });
  }
};

/** ASCII bytes, the way the reference writes `k` (keys are ASCII by rule). */
const asciiBytes = (value: string) =>
  Uint8Array.from(value, (character) => character.charCodeAt(0));

const asciiString = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

/** How many leading characters two keys share. */
export const countPrefixLen = (a: string, b: string) => {
  const shared = Array.from(
    { length: Math.min(a.length, b.length) },
    (_unused, index) => index,
  ).find((index) => a[index] !== b[index]);
  return shared ?? Math.min(a.length, b.length);
};

/**
 * The leading zero *bits* of a byte, by the reference's rule: it tests the top
 * two, four, six and eight bits in turn, so a byte below 64 counts one, below
 * 16 two, below 4 three, and zero counts four.
 */
const zeroBitsOfByte = (byte: number) =>
  (byte < 64 ? 1 : 0) +
  (byte < 16 ? 1 : 0) +
  (byte < 4 ? 1 : 0) +
  (byte === 0 ? 1 : 0);

/** A zero byte contributes four zero bits and does not stop the count. */
const ZERO_BYTE_BITS = 4;

/**
 * The layer a key sits at: the leading zero bits of `sha256(key)`. This single
 * rule is what makes the tree a *search* tree - keys spread across layers by
 * hash, so no insertion order can degenerate it.
 */
export const leadingZerosOnHash = (key: string) =>
  Effect.gen(function* () {
    const hash = yield* sha256(TEXT_ENCODER.encode(key));
    const firstNonZero = hash.findIndex((byte) => byte !== 0);
    if (firstNonZero < 0) {
      return hash.length * ZERO_BYTE_BITS;
    }
    return (
      firstNonZero * ZERO_BYTE_BITS + zeroBitsOfByte(hash[firstNonZero] ?? 0)
    );
  });

/**
 * A node's layer is its first *leaf*'s layer - not its first entry, because a
 * node may open with the subtree that holds the keys before it.
 */
export const layerForEntries = (entries: readonly MstNodeEntry[]) =>
  Effect.gen(function* () {
    const firstLeaf = entries.find((entry) => entry instanceof MstLeaf);
    if (firstLeaf === undefined) {
      return yield* new InvalidMstNodeError({
        message: 'a node needs a leaf to have a layer',
      });
    }
    return yield* leadingZerosOnHash(firstLeaf.key);
  });

/**
 * Serializes a node's contents, compressing each key against the one before it.
 *
 * The prefix length is relative to the previous key *in this node*, and the
 * first key is written whole (its prefix is measured against the empty string).
 */
export const serializeNodeData = (entries: readonly MstNodeEntry[]) => {
  entries.forEach((entry, index) => {
    if (
      entry instanceof MstSubtree &&
      index !== 0 &&
      !(entries[index - 1] instanceof MstLeaf)
    ) {
      throw new InvalidMstNodeError({
        message: 'two subtrees next to each other',
      });
    }
  });

  const [first] = entries;
  const serialized: MstNodeData['e'] = [];
  entries.reduce<string>((lastKey, entry, index) => {
    if (!(entry instanceof MstLeaf)) {
      return lastKey;
    }
    ensureValidMstKey(entry.key);
    const prefixLength = countPrefixLen(lastKey, entry.key);
    const next = entries[index + 1];
    serialized.push({
      p: prefixLength,
      k: asciiBytes(entry.key.slice(prefixLength)),
      v: new CidLink({ cid: entry.value }),
      t: next instanceof MstSubtree ? new CidLink({ cid: next.subtree }) : null,
    });
    return entry.key;
  }, '');

  return {
    l: first instanceof MstSubtree ? new CidLink({ cid: first.subtree }) : null,
    e: serialized,
  };
};

/** Rebuilds a node's contents from its serialized form. */
export const deserializeNodeData = (data: MstNodeData) => {
  const entries: MstNodeEntry[] =
    data.l === null ? [] : [new MstSubtree({ subtree: data.l.cid })];

  data.e.reduce<string>((lastKey, entry) => {
    const key = `${lastKey.slice(0, entry.p)}${asciiString(entry.k)}`;
    ensureValidMstKey(key);
    entries.push(new MstLeaf({ key, value: entry.v.cid }));
    if (entry.t !== null) {
      entries.push(new MstSubtree({ subtree: entry.t.cid }));
    }
    return key;
  }, '');

  return entries;
};

/**
 * The node's block: its bytes and the CID they hash to. Both, because a repo
 * needs the bytes to write and the CID to link - and hashing twice would be a
 * chance for the two to disagree.
 */
export const encodeNode = (entries: readonly MstNodeEntry[]) =>
  Effect.gen(function* () {
    const bytes = encodeCbor(serializeNodeData(entries));
    const digest = yield* sha256(bytes);
    return {
      bytes,
      cid: cidFromDigest({ codec: CODEC_DAG_CBOR, digest }),
    };
  });

/**
 * A node as it appears in a block. Validated rather than asserted: a block read
 * out of a CAR is untrusted input, and a malformed one should fail loudly here
 * rather than halfway through a tree walk.
 */
const MstNodeDataSchema = Schema.Struct({
  l: Schema.NullOr(Schema.instanceOf(CidLink)),
  e: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        p: Schema.Int,
        k: Schema.Uint8Array,
        v: Schema.instanceOf(CidLink),
        t: Schema.NullOr(Schema.instanceOf(CidLink)),
      }),
    ),
  ),
});

/** Decodes a node block, rejecting anything that is not one. */
export const decodeNodeData = (bytes: Uint8Array) =>
  Schema.decodeUnknownSync(MstNodeDataSchema)(decodeCbor(bytes));
