import type { Key, Sequence, Value } from './types.js';
import { Option, Schema } from 'effect';

/**
 * The run format (the Effect-PDS map, `6zri`).
 *
 * A run used to be one object holding a JSON array of every entry, which made
 * every read a whole-run fetch and every merge a whole-run rewrite. It is now a
 * **sparse index** and a set of **blocks**:
 *
 * - a block is a byte-addressable record list — key length, key, version, value
 *   length, value — so decoding it is a walk and not a parse;
 * - the index names each block by its **first key**, which is all a seek needs:
 *   the block holding a key is the last one whose first key is at or below it;
 * - and because a block is an object of its own, it is fetched alone and cached
 *   alone, rather than dragging the whole run through memory.
 *
 * Entries are ordered by key, then by version, so a block's range is a range of
 * keys and a lookup inside it is a scan of one block.
 */

/** Enough entries that a block is worth a request, few enough to cache. */
export const BLOCK_ENTRIES = 512;

/** The first four bytes of a block: `KVB1`, so a foreign object is refused. */
const MAGIC = 0x4b_56_42_31;

/** A value length of this means "no value" — a tombstone. */
const TOMBSTONE = 0xff_ff_ff_ff;

/** One versioned write, as a block carries it. */
export interface BlockEntry {
  readonly key: Key;
  readonly version: Sequence;
  readonly value: Value | undefined;
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

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

/**
 * A block, as bytes. Lengths are explicit rather than delimited, because a key
 * or a value may contain any byte at all.
 */
export const encodeBlock = (entries: ReadonlyArray<BlockEntry>) => {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, MAGIC);
  headerView.setUint32(4, entries.length);
  parts.push(header);

  for (const entry of entries) {
    const key = encoder.encode(entry.key);
    const value = entry.value;
    const record = new Uint8Array(2 + key.length + 8 + 4);
    const recordView = new DataView(record.buffer);
    recordView.setUint16(0, key.length);
    record.set(key, 2);
    recordView.setFloat64(2 + key.length, entry.version);
    recordView.setUint32(
      2 + key.length + 8,
      value === undefined ? TOMBSTONE : value.length,
    );
    parts.push(record);
    if (value !== undefined) {
      parts.push(value);
    }
  }

  return concat(parts);
};

/** A block, read back — or nothing, when the bytes are not a block we wrote. */
export const decodeBlock = (bytes: Value) => {
  if (bytes.byteLength < 8) {
    return Option.none<ReadonlyArray<BlockEntry>>();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== MAGIC) {
    return Option.none<ReadonlyArray<BlockEntry>>();
  }

  /** One entry starting at `at`, and where the one after it starts. */
  const entryAt = (at: number) => {
    if (at + 2 > bytes.byteLength) {
      return Option.none();
    }
    const keyLength = view.getUint16(at);
    const keyStart = at + 2;
    if (keyStart + keyLength + 12 > bytes.byteLength) {
      return Option.none();
    }
    const key = decoder.decode(bytes.subarray(keyStart, keyStart + keyLength));
    const version = view.getFloat64(keyStart + keyLength);
    const lengthAt = keyStart + keyLength + 8;
    const valueLength = view.getUint32(lengthAt);
    const valueStart = lengthAt + 4;
    if (valueLength === TOMBSTONE) {
      const entry: BlockEntry = { key, version, value: undefined };
      return Option.some({ entry, next: valueStart });
    }
    if (valueStart + valueLength > bytes.byteLength) {
      return Option.none();
    }
    const entry: BlockEntry = {
      key,
      version,
      value: bytes.slice(valueStart, valueStart + valueLength),
    };
    return Option.some({ entry, next: valueStart + valueLength });
  };

  // A fold rather than a walk with a cursor: the records carry their own lengths,
  // so each step is a pure function of where the last one ended.
  const walked = Array.from({ length: view.getUint32(4) }).reduce<
    Option.Option<{
      readonly entries: ReadonlyArray<BlockEntry>;
      readonly at: number;
    }>
  >(
    (so, _unused) =>
      Option.flatMap(so, (state) =>
        Option.map(entryAt(state.at), (read) => ({
          entries: [...state.entries, read.entry],
          at: read.next,
        })),
      ),
    Option.some({ entries: [], at: 8 }),
  );

  return Option.map(walked, (state) => state.entries);
};

/** Where a run's blocks are, and what covers what. */
export const BlockSchema = Schema.Struct({
  name: Schema.String,
  firstKey: Schema.String,
  entries: Schema.Number,
});

export const RunIndexSchema = Schema.Struct({
  level: Schema.Number,
  from: Schema.Number,
  to: Schema.Number,
  blocks: Schema.Array(BlockSchema),
});

export type RunIndex = Schema.Schema.Type<typeof RunIndexSchema>;

const decodeRunIndex = Schema.decodeUnknownOption(
  Schema.fromJsonString(RunIndexSchema),
);
const encodeRunIndex = Schema.encodeSync(Schema.fromJsonString(RunIndexSchema));

export const encodeIndex = (index: RunIndex) => encodeRunIndex(index);

export const decodeIndex = (text: string) => decodeRunIndex(text);

/**
 * The run's index object. It stays under `sst/`, one per run, because that is
 * what a run *is* — its blocks are separate objects with a prefix of their own.
 */
export const indexName = (level: number, from: Sequence, to: Sequence) =>
  `sst/${level}/${from}-${to}`;

export const blockName = (index: string, at: number) =>
  `blk/${index.slice(4)}/${at}`;

/** The blocks a run's objects are, in order — for recovery and for a scan. */
export const blocksOf = (index: RunIndex) =>
  index.blocks.map((block) => block.name);

/**
 * Which block holds this key: the last one whose first key is at or below it.
 * That is the whole of a seek — no block is read to find out.
 */
export const blockHolding = (index: RunIndex, key: Key) => {
  const found = index.blocks.filter((block) => block.firstKey <= key).at(-1);
  return found === undefined ? Option.none<string>() : Option.some(found.name);
};

/** Split entries into blocks, in order, with the first key of each. */
export const toBlocks = (index: string, entries: ReadonlyArray<BlockEntry>) =>
  Array.from(
    { length: Math.ceil(entries.length / BLOCK_ENTRIES) },
    (_unused, at) =>
      entries.slice(at * BLOCK_ENTRIES, (at + 1) * BLOCK_ENTRIES),
  ).map((group, at) => ({
    name: blockName(index, at),
    firstKey: group.at(0)?.key ?? '',
    entries: group.length,
    group,
  }));
