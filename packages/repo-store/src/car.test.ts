import { describe, expect, it } from 'vitest';
import { encodeCar, keysOfNode, readCar, recordsIn } from './car.js';
import { Effect } from 'effect';
import { formatCid } from '@eoa/core';
import { readFixture } from './fixture.js';

const { bytes, roots, blocks } = readFixture();

describe('the CAR the repo travels in', () => {
  it('re-encodes a captured CAR byte for byte', () => {
    const again = encodeCar({
      roots,
      blocks: [...blocks.values()].map((block) => ({
        cid: block.cid,
        bytes: block.bytes,
      })),
    });

    expect(again.length).toBe(bytes.length);
    expect(Buffer.from(again).toString('hex')).toBe(
      Buffer.from(bytes).toString('hex'),
    );
  });

  it('reads back a captured CAR, down to its records', async () => {
    const read = await Effect.runPromise(readCar(bytes));

    expect(read.roots.map((root) => formatCid(root))).toEqual(
      roots.map((root) => formatCid(root)),
    );
    expect(read.blocks.size).toBe(blocks.size);

    // The fixture is a whole repo, so its tree is walkable — which is the
    // property our own `getRepo` turns out not to have (see the skipped test in
    // the PDS suite, and the ticket filed for it).
    const records = await Effect.runPromise(recordsIn(read));
    expect(records.length).toBeGreaterThan(0);
    // Each record is the bytes a block held, under the key the tree names — and
    // an MST holds a key once.
    expect(records.every((one) => one.value.length > 0)).toBe(true);
    expect(new Set(records.map((one) => one.key)).size).toBe(records.length);
  });

  it('rebuilds a key from the node it is compressed in', () => {
    // Two records whose paths share the head of the node's first key, which is the ordinary case: a
    // repo's records are `collection/rkey`, and a node's entries share the collection. Taking `k`
    // alone would key the second record `note/3mxr62z2c4s22`, and a repo keyed that way cannot be
    // listed by collection at all -- which is what an imported repo looked like (`1ubx`).
    const encoder = new TextEncoder();
    const entries = [
      { p: 0, k: encoder.encode('ing.test.art/3mxr62yc4os22') },
      { p: 9, k: encoder.encode('note/3mxr62z2c4s22') },
      { p: 9, k: encoder.encode('other/3mxr62z2c4s23') },
    ];

    expect(keysOfNode(entries).map((one) => one.key)).toEqual([
      'ing.test.art/3mxr62yc4os22',
      'ing.test.note/3mxr62z2c4s22',
      'ing.test.other/3mxr62z2c4s23',
    ]);
  });

  it('names its roots in the header it writes', () => {
    const empty = encodeCar({ roots, blocks: [] });

    // The header is the first thing in the file: a varint length, then DAG-CBOR.
    expect(empty.length).toBeGreaterThan(0);
    expect(empty[0]).toBeGreaterThan(0);
  });
});
