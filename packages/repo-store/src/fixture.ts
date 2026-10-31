import {
  CidLink,
  cidFromBytes,
  cidFromDigest,
  decodeCbor,
  formatCid,
} from '@eoa/core';
import { Result, Schema } from 'effect';
import type { Block } from './mst-tree.js';
import { readFileSync } from 'node:fs';

/**
 * The repository the tests in this package are checked against: 23 blocks (one
 * commit, six MST nodes, sixteen records), captured from a public PDS on
 * 2026-09-24. Small, but it has interior structure — two nodes with a left
 * subtree, three entries with child subtrees — which is where a wrong prefix
 * length or link encoding shows up.
 */
const CID_HEADER_BYTES = 4;

const readVarint = (bytes: Uint8Array, offset: number) =>
  Array.from({ length: 10 }, (_unused, index) => index).reduce<{
    readonly value: number;
    readonly next: number;
    readonly done: boolean;
  }>(
    (state, index) =>
      state.done
        ? state
        : {
            value:
              state.value +
              ((bytes[offset + index] ?? 0) & 0x7f) * 2 ** (7 * index),
            next: offset + index + 1,
            done: ((bytes[offset + index] ?? 0) & 0x80) === 0,
          },
    { value: 0, next: offset, done: false },
  );

const HeaderSchema = Schema.Struct({
  version: Schema.Number,
  roots: Schema.Array(Schema.instanceOf(CidLink)),
});

/** Read the fixture: its header, and every block keyed by CID. */
export const readFixture = () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('../fixtures/repo-sample.car', import.meta.url)),
  );

  const header = readVarint(bytes, 0);
  const blocks = new Map<string, Block>();

  const walk = (offset: number) => {
    if (offset >= bytes.length) {
      return;
    }
    const length = readVarint(bytes, offset);
    const start = length.next;
    const cidLength = CID_HEADER_BYTES + (bytes[start + 3] ?? 0);
    const declared = cidFromBytes(bytes.slice(start, start + cidLength));
    if (Result.isSuccess(declared)) {
      const cid = cidFromDigest({
        codec: declared.success.codec,
        digest: declared.success.digest,
      });
      blocks.set(formatCid(cid), {
        cid,
        bytes: bytes.slice(start + cidLength, start + length.value),
      });
    }
    walk(start + length.value);
  };
  walk(header.next + header.value);

  const parsed = Schema.decodeUnknownSync(HeaderSchema)(
    decodeCbor(bytes.slice(header.next, header.next + header.value)),
  );

  return {
    bytes,
    roots: parsed.roots.map((link) => link.cid),
    blocks,
  };
};
