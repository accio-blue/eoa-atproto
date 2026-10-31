import {
  BLOCK_ENTRIES,
  blockHolding,
  decodeBlock,
  decodeIndex,
  encodeBlock,
  encodeIndex,
  indexName,
  toBlocks,
} from './run.js';
import { describe, expect, it } from 'vitest';
import { Option } from 'effect';

const bytes = (value: string) => new TextEncoder().encode(value);

const entry = (key: string, version: number, value: string | undefined) => ({
  key,
  version,
  value: value === undefined ? undefined : bytes(value),
});

describe('the run format', () => {
  it('round-trips a block, tombstones and all', () => {
    const decoded = decodeBlock(
      encodeBlock([
        entry('a', 1, 'one'),
        entry('b', 2, undefined),
        entry('c', 3, 'three'),
      ]),
    );
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) {
      return;
    }
    expect(decoded.value.map((one) => one.key)).toEqual(['a', 'b', 'c']);
    expect(decoded.value.map((one) => one.version)).toEqual([1, 2, 3]);
    expect(decoded.value[0]?.value).toEqual(bytes('one'));
    // A tombstone is a record with no value, not a record that is missing.
    expect(decoded.value[1]?.value).toBeUndefined();
    expect(decoded.value[1]?.key).toBe('b');
  });

  it('refuses bytes that are not a block', () => {
    expect(Option.isNone(decodeBlock(bytes('not a block at all')))).toBe(true);
    expect(Option.isNone(decodeBlock(new Uint8Array(0)))).toBe(true);
    expect(Option.isNone(decodeBlock(new Uint8Array(4)))).toBe(true);
  });

  it('round-trips an index, and seeks by first key', () => {
    const name = indexName(2, 5, 9);
    const entries = Array.from(
      { length: BLOCK_ENTRIES * 2 + 1 },
      (_unused, at) => entry(`k${String(at).padStart(5, '0')}`, 1, undefined),
    );
    const blocks = toBlocks(name, entries);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.entries).toBe(BLOCK_ENTRIES);

    const decoded = decodeIndex(
      encodeIndex({
        level: 2,
        from: 5,
        to: 9,
        blocks: blocks.map((one) => ({
          name: one.name,
          firstKey: one.firstKey,
          entries: one.entries,
        })),
      }),
    );
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) {
      return;
    }
    expect(decoded.value.level).toBe(2);
    expect(decoded.value.from).toBe(5);

    // The seek is arithmetic: the block holding a key is the last whose first
    // key is at or below it, and nothing is read to find that out.
    expect(Option.getOrThrow(blockHolding(decoded.value, 'k00000'))).toBe(
      blocks[0]?.name,
    );
    expect(
      Option.getOrThrow(
        blockHolding(
          decoded.value,
          `k${String(BLOCK_ENTRIES).padStart(5, '0')}`,
        ),
      ),
    ).toBe(blocks[1]?.name);
    expect(
      Option.getOrThrow(
        blockHolding(
          decoded.value,
          `k${String(BLOCK_ENTRIES * 2).padStart(5, '0')}`,
        ),
      ),
    ).toBe(blocks[2]?.name);
    // A key below every block has no block to be in.
    expect(Option.isNone(blockHolding(decoded.value, 'a'))).toBe(true);
  });
});
