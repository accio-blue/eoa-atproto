import { Schema } from 'effect';

/** A repo's head: the commit it is at, and the revision it belongs to. */
export interface Head {
  readonly root: string;
  readonly rev: string;
}

/** A record as the store keeps it: the record key, and its bytes. */
export interface StoredRecord {
  readonly key: string;
  readonly value: Uint8Array;
}

/** A block: its bytes, under the CID they hash to. */
export interface StoredBlock {
  readonly cid: string;
  readonly bytes: Uint8Array;
}

/** A row was handed to the store that is not the row it claims to be. */
export class CorruptRow extends Schema.TaggedError<CorruptRow>()('CorruptRow', {
  key: Schema.String,
}) {}

/**
 * A leaf-only node was handed to the store. Leaves are never stored: their keys
 * *and* values are the `R/` rows in their range, so a node that branches on
 * nothing is a mistake in the caller, not a block.
 */
export class LeafNodeNotStored extends Schema.TaggedError<LeafNodeNotStored>()(
  'LeafNodeNotStored',
  { cid: Schema.String },
) {}
