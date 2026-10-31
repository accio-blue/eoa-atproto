import {
  type Cid,
  CidLink,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import { Effect, Option, Schema } from 'effect';
import { decodeCommit } from './commit.js';
import { decodeNodeData } from './mst.js';

/**
 * The CAR the repo travels in: a header naming its roots, then every block,
 * each length-prefixed.
 *
 * This is what `com.atproto.sync.getRepo` answers with, and what a client reads
 * to walk a repo it does not have — so the bytes are a contract, not a format
 * of ours: the header's roots, the block order and the CID encoding all have to
 * be what the reference writes. The acceptance re-encodes a captured CAR and
 * compares it byte for byte.
 */

/** The multihash a CIDv1 carries here: sha2-256. */
const MULTIHASH_SHA2_256 = 0x12;

/** A CIDv1 as a CAR writes it: version, codec, multihash. */
const cidBytes = (cid: Cid) =>
  Uint8Array.from([
    cid.version,
    cid.codec,
    MULTIHASH_SHA2_256,
    cid.digest.length,
    ...cid.digest,
  ]);

/** An unsigned LEB128 varint — the length prefix a CAR block carries. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
/** An unsigned LEB128 varint — the length prefix a CAR block carries. */
const varint = (value: number) => {
  const written = Array.from({ length: 10 }, (_unused, index) => index).reduce<{
    readonly left: number;
    readonly bytes: ReadonlyArray<number>;
  }>(
    (state) => {
      if (state.left === 0) {
        return state;
      }
      const byte = state.left & 0x7f;
      const left = Math.floor(state.left / 128);
      return {
        left,
        bytes: [...state.bytes, left > 0 ? byte | 0x80 : byte],
      };
    },
    { left: value, bytes: [] },
  );

  return Uint8Array.from(written.bytes.length === 0 ? [0] : written.bytes);
};

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  parts.reduce((at, part) => {
    joined.set(part, at);
    return at + part.length;
  }, 0);
  return joined;
};

/** Encode a CARv1: the header, then every block, in the order given. */
export const encodeCar = (params: {
  readonly roots: ReadonlyArray<Cid>;
  readonly blocks: ReadonlyArray<{
    readonly cid: Cid;
    readonly bytes: Uint8Array;
  }>;
}) => {
  const header = encodeCbor({
    version: 1,
    roots: params.roots.map((cid) => new CidLink({ cid })),
  });

  return concat([
    varint(header.length),
    header,
    ...params.blocks.flatMap((block) => {
      const payload = concat([cidBytes(block.cid), block.bytes]);
      return [varint(payload.length), payload];
    }),
  ]);
};

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

const VARINT_MAX_BYTES = 6;

/** Reported when bytes are not a CAR we can read. */
export class CarReadError extends Schema.TaggedError<CarReadError>()(
  'CarReadError',
  { message: Schema.String },
) {}

/** A CAR, read: its roots, and its blocks by CID. */
export interface Car {
  readonly roots: ReadonlyArray<Cid>;
  readonly blocks: ReadonlyMap<
    string,
    { readonly cid: Cid; readonly bytes: Uint8Array }
  >;
}

/** Reads a varint at an offset: the value, and the offset just past it. */
const readVarint = (bytes: Uint8Array, offset: number) =>
  Array.from({ length: VARINT_MAX_BYTES }, (_unused, index) => index).reduce<{
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

/** One block: the CID it declares, and the bytes it carries. */
const readBlock = (payload: Uint8Array) => {
  // A CIDv1 as a CAR writes it: version, codec, multihash code, digest length,
  // digest — and then the block's own bytes.
  const version = payload[0] ?? 0;
  const codec = payload[1] ?? 0;
  const digestLength = payload[3] ?? 0;
  const digest = payload.slice(4, 4 + digestLength);
  if (version !== 1) {
    return Option.none<{ cid: Cid; bytes: Uint8Array }>();
  }
  return Option.some({
    cid: cidFromDigest({ codec, digest }),
    bytes: payload.slice(4 + digestLength),
  });
};

const CarHeaderSchema = Schema.Struct({
  roots: Schema.mutable(Schema.Array(Schema.instanceOf(CidLink))),
  version: Schema.Literal(1),
});

/** Read a CARv1: the header, then every block. */
export const readCar = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const headerLength = readVarint(bytes, 0);
    const header = Schema.decodeUnknownOption(CarHeaderSchema)(
      decodeCbor(
        bytes.slice(headerLength.next, headerLength.next + headerLength.value),
      ),
    );
    if (Option.isNone(header)) {
      return yield* new CarReadError({
        message: 'the header is not { roots: [CID...], version: 1 }',
      });
    }

    const blocks = new Map<string, { cid: Cid; bytes: Uint8Array }>();
    const at = { offset: headerLength.next + headerLength.value };
    while (at.offset < bytes.length) {
      const length = readVarint(bytes, at.offset);
      const block = readBlock(
        bytes.slice(length.next, length.next + length.value),
      );
      if (Option.isNone(block)) {
        return yield* new CarReadError({
          message: `the block at ${at.offset} is not a CIDv1 block`,
        });
      }
      blocks.set(formatCid(block.value.cid), block.value);
      at.offset = length.next + length.value;
    }

    return {
      roots: header.value.roots.map((link) => link.cid),
      blocks,
    };
  });

/** A record as it travels: the key the MST holds it under, and its bytes. */
export interface CarRecord {
  readonly key: string;
  readonly value: Uint8Array;
}

const keyDecoder = new TextDecoder();

/**
 * A node's entries, each with the **full key** it holds.
 *
 * The keys inside a node are compressed against each other: `p` is how many bytes of the *previous*
 * entry's key survive, and `k` is the rest. A reader that takes `k` alone holds every record under a
 * suffix of its path — a repo whose records cannot be listed by collection, which is what an imported
 * repo looked like until this (`1ubx`).
 */
export const keysOfNode = <
  E extends { readonly p: number; readonly k: Uint8Array },
>(
  entries: ReadonlyArray<E>,
): ReadonlyArray<{ readonly key: string; readonly entry: E }> => {
  const held: Array<{ readonly key: string; readonly entry: E }> = [];
  let last = '';
  for (const entry of entries) {
    last = last.slice(0, entry.p) + keyDecoder.decode(entry.k);
    held.push({ key: last, entry });
  }
  return held;
};

/**
 * The records a CAR holds, by walking the MST from its root commit.
 *
 * A CAR is blocks, not a list of records: which block is a record, and under
 * what key, is the tree's business. So this reads the root commit, takes the
 * tree it names, and walks — which is also the only way to be sure the CAR is
 * one we can actually hold.
 */
export const recordsIn = (car: Car) =>
  Effect.gen(function* () {
    const root = car.roots.at(0);
    if (root === undefined) {
      return yield* new CarReadError({ message: 'the CAR has no roots' });
    }
    const commitBytes = car.blocks.get(formatCid(root))?.bytes;
    if (commitBytes === undefined) {
      return yield* new CarReadError({
        message: 'the CAR does not carry the commit it roots at',
      });
    }
    const commit = yield* Effect.try({
      try: () => decodeCommit(commitBytes),
      catch: (cause) =>
        new CarReadError({
          message: `the root is not a commit: ${String(cause)}`,
        }),
    });

    const held: CarRecord[] = [];
    // A worklist rather than a recursion: the list grows as it is walked, which
    // is what lets one pass visit every node without a return type to write down.
    const pending: Cid[] = [commit.data.cid];
    for (const at of pending) {
      const bytes = car.blocks.get(formatCid(at))?.bytes;
      if (bytes === undefined) {
        return yield* new CarReadError({
          message: `the CAR does not carry the node ${formatCid(at)}`,
        });
      }
      const node = yield* Effect.try({
        try: () => decodeNodeData(bytes),
        catch: (cause) =>
          new CarReadError({
            message: `a node is not a node: ${String(cause)}`,
          }),
      });

      if (node.l !== null) {
        pending.push(node.l.cid);
      }
      for (const { key, entry } of keysOfNode(node.e)) {
        const record = car.blocks.get(formatCid(entry.v.cid))?.bytes;
        if (record === undefined) {
          return yield* new CarReadError({
            message: `the CAR does not carry the record ${formatCid(entry.v.cid)}`,
          });
        }
        held.push({ key, value: record });
        if (entry.t !== null) {
          pending.push(entry.t.cid);
        }
      }
    }
    return held;
  });
