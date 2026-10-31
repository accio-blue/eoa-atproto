import {
  type Cid,
  CidLink,
  cidBytes,
  cidFromBytes,
  cidFromDigest,
  concatBytes,
  decodeCbor,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import { Effect, Option, Result, Schema } from 'effect';
import { type Block } from './mst-tree.js';
import { sha256 } from '@eoa/crypto';

/**
 * CAR v1: the container an atproto repository travels in.
 *
 * `[varint len][dag-cbor { roots, version }]`, then `[varint len][cid || block]`
 * per block. Block order is unspecified and the root need not come first - the
 * real 23-block fixture does not - so a reader indexes by CID and a writer may
 * emit any order.
 *
 * Reading verifies every block against the CID it arrived with. That is the
 * whole integrity story of a CAR, and it is worth doing on the way in rather
 * than trusting a hash someone else computed: a CAR that fails it is a
 * different repository than the one that was asked for.
 */

/** The only CAR version there is. */
const CAR_VERSION = 1;

/** A CIDv1 header is version, codec, multihash code and digest length. */
const CID_HEADER_BYTES = 4;

/** The widest a varint can be here: 64 bits in 7-bit groups. */
const VARINT_MAX_BYTES = 10;

/** The dag-cbor header of a CARv1. */
const CarHeaderSchema = Schema.Struct({
  roots: Schema.mutable(Schema.Array(Schema.instanceOf(CidLink))),
  version: Schema.Literal(CAR_VERSION),
});

/** Reported when bytes are not a CAR we can read. */
export class CarReadError extends Schema.TaggedError<CarReadError>()(
  'CarReadError',
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Varints
// ---------------------------------------------------------------------------

/** The number of 7-bit groups a value needs, at least one. */
const varintWidth = (value: number) => {
  const groups = Array.from({ length: VARINT_MAX_BYTES }).findIndex(
    (_unused, index) => value < 2 ** (7 * (index + 1)),
  );
  return groups < 0 ? VARINT_MAX_BYTES : groups + 1;
};

const varintGroup = (params: {
  readonly value: number;
  readonly index: number;
}) => Math.floor(params.value / 2 ** (7 * params.index)) % 128;

/** LEB128, little-endian in 7-bit groups with a continuation bit. */
const encodeVarint = (value: number) => {
  const width = varintWidth(value);
  return Uint8Array.from({ length: width }, (_unused, index) =>
    index === width - 1
      ? varintGroup({ value, index })
      : varintGroup({ value, index }) | 0x80,
  );
};

/** A position in a CAR: the bytes, and where we are in them. */
type Cursor = {
  readonly bytes: Uint8Array;
  readonly offset: number;
};

/** Reads a varint: the value, and the offset just past it. */
const readVarint = (params: Cursor) =>
  Array.from({ length: VARINT_MAX_BYTES }, (_unused, index) => index).reduce<{
    value: number;
    next: number;
    done: boolean;
  }>(
    (state, index) => {
      if (state.done) {
        return state;
      }
      const byte = params.bytes[params.offset + index] ?? 0;
      return {
        value: state.value + (byte & 0x7f) * 2 ** (7 * index),
        next: params.offset + index + 1,
        done: (byte & 0x80) === 0,
      };
    },
    { value: 0, next: params.offset, done: false },
  );

/** The offset just past the block that starts at `offset`. */
const endOfBlock = (params: Cursor) => {
  const length = readVarint({ bytes: params.bytes, offset: params.offset });
  return length.next + length.value;
};

// Recursive, so TypeScript cannot infer the return type (TS7023); the
// annotation is required here, not stylistic.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
const blockOffsets = (params: Cursor): number[] =>
  params.offset >= params.bytes.length
    ? []
    : [
        params.offset,
        ...blockOffsets({ bytes: params.bytes, offset: endOfBlock(params) }),
      ];

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * One block, with its bytes re-hashed and checked against the CID it came with.
 * The CID's own length comes from its header, because that is what varies.
 */
const readBlock = (params: Cursor) =>
  Effect.gen(function* () {
    const length = readVarint({ bytes: params.bytes, offset: params.offset });
    const cidStart = length.next;
    const cidLength = CID_HEADER_BYTES + (params.bytes[cidStart + 3] ?? 0);
    const declared = cidFromBytes(
      params.bytes.slice(cidStart, cidStart + cidLength),
    );

    if (Result.isFailure(declared)) {
      return yield* new CarReadError({
        message: `the block at ${params.offset} does not start with a CID: ${declared.failure.message}`,
      });
    }

    const blockBytes = params.bytes.slice(
      cidStart + cidLength,
      cidStart + length.value,
    );
    const digest = yield* sha256(blockBytes);
    const derived = cidFromDigest({ codec: declared.success.codec, digest });

    if (formatCid(derived) !== formatCid(declared.success)) {
      return yield* new CarReadError({
        message: `the block at ${params.offset} hashes to ${formatCid(derived)}, not to ${formatCid(declared.success)}`,
      });
    }

    return { cid: declared.success, bytes: blockBytes } satisfies Block;
  });

/** A CAR, read: its roots, and its blocks indexed by CID. */
export type Car = {
  readonly roots: readonly Cid[];
  readonly blocks: Map<string, Block>;
};

/** Read a CARv1, verifying every block as it goes. */
export const readCar = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const headerLength = readVarint({ bytes, offset: 0 });
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

    const blocks = new Map<string, Block>();
    const read = yield* Effect.forEach(
      blockOffsets({ bytes, offset: headerLength.next + headerLength.value }),
      (offset) => readBlock({ bytes, offset }),
    );
    read.forEach((block) => blocks.set(formatCid(block.cid), block));

    return { roots: header.value.roots.map((link) => link.cid), blocks };
  });

/** Encode a CARv1: the header, then every block. */
export const encodeCar = (params: {
  readonly roots: readonly Cid[];
  readonly blocks: readonly Block[];
}) => {
  const header = encodeCbor({
    roots: params.roots.map((cid) => new CidLink({ cid })),
    version: CAR_VERSION,
  });

  return concatBytes([
    encodeVarint(header.length),
    header,
    ...params.blocks.flatMap((block) => {
      const cidPart = cidBytes(block.cid);
      return [
        encodeVarint(cidPart.length + block.bytes.length),
        cidPart,
        block.bytes,
      ];
    }),
  ]);
};
