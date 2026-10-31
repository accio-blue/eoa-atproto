import { Data, Schema } from 'effect';

/** Keys are ordered lexicographically — the KV's only ordering. */
export type Key = string;

/** Values are opaque bytes; the KV never interprets them. */
export type Value = Uint8Array;

/** A commit sequence: the KV's clock. Every accepted batch advances it by one. */
export type Sequence = number;

/**
 * A write's precondition: `absent` (create-only), or `version`
 * (replace-only-if-unchanged, the version the caller last read).
 */
export type ConditionMap = Data.TaggedEnum<{
  readonly absent: {};
  readonly version: { readonly version: Sequence };
}>;

export const { absent: absentCondition, version: versionCondition } =
  Data.taggedEnum<ConditionMap>();

/**
 * A write was refused: the key was not in the state the caller assumed. A
 * refusal, not an error — the caller re-reads and retries.
 */
export class KeyPreconditionFailed extends Schema.TaggedError<KeyPreconditionFailed>()(
  'KeyPreconditionFailed',
  { key: Schema.String, expected: Schema.String },
) {}

/** A cursor that does not parse, or that disagrees with the requested snapshot. */
export class CursorInvalid extends Schema.TaggedError<CursorInvalid>()(
  'CursorInvalid',
  { cursor: Schema.String },
) {}

/**
 * The store could not be reached, or a durable write could not be completed.
 * The in-memory backend never raises it; a store on disk or a bucket does.
 */
export class KvUnavailable extends Schema.TaggedError<KvUnavailable>()(
  'KvUnavailable',
  { message: Schema.String },
) {}

/**
 * The sequence asked for is older than what the store still holds. History is
 * read **under a hold**: a reader takes a snapshot at the sequence it wants,
 * and until it lets go nothing below it may be dropped. Every backend enforces
 * this, so development cannot read history the bucket would refuse.
 */
export class SnapshotExpired extends Schema.TaggedError<SnapshotExpired>()(
  'SnapshotExpired',
  { at: Schema.Number, oldest: Schema.Number },
) {}

export type KvError =
  | KeyPreconditionFailed
  | CursorInvalid
  | KvUnavailable
  | SnapshotExpired;

/** One write in a batch. A batch is atomic: all of it, or none of it. */
export type OpMap = Data.TaggedEnum<{
  readonly put: {
    readonly key: Key;
    readonly value: Value;
    readonly condition?: ConditionMap;
  };
  readonly delete: { readonly key: Key; readonly condition?: ConditionMap };
}>;

export const { put: putOp, delete: deleteOp } = Data.taggedEnum<OpMap>();

export interface Entry {
  readonly key: Key;
  readonly value: Value;
  /** The sequence at which this value was written. */
  readonly version: Sequence;
}

export interface ScanOptions {
  /** Only keys carrying this prefix. */
  readonly prefix?: string;
  /** Inclusive lower bound; defaults to `prefix`. */
  readonly start?: string;
  /** Exclusive upper bound. */
  readonly end?: string;
  readonly limit?: number;
  /** Resume an earlier scan; carries its snapshot, so a disagreeing `at` fails. */
  readonly cursor?: string;
  /** Read at this snapshot; defaults to the current sequence. */
  readonly at?: Sequence;
}

export interface ScanPage {
  /** The snapshot every entry in this page was read at. */
  readonly at: Sequence;
  readonly entries: ReadonlyArray<Entry>;
  /** Present when more entries follow; hand it back as `cursor`. */
  readonly cursor?: string;
}
