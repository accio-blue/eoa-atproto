import { Data, Schema } from 'effect';

/** A key is the object's name; the store keeps whatever bytes it is given. */
export type ObjectKey = string;

/** An object's body, opaque to the store. */
export type ObjectBody = Uint8Array;

/**
 * An object's version: what a conditional write compares against. On the
 * filesystem it is the body's digest, so it changes exactly when the bytes do.
 */
export type ETag = string;

/** What a write may require of the object it is about to replace. */
export type WriteConditionMap = Data.TaggedEnum<{
  readonly absent: {};
  readonly holds: { readonly etag: ETag };
}>;

export const { absent: ifAbsent, holds: ifHolds } =
  Data.taggedEnum<WriteConditionMap>();

/** A conditional write was refused: the object was not as the caller assumed. */
export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()(
  'PreconditionFailed',
  { key: Schema.String, expected: Schema.String },
) {}

/**
 * The store could not be reached, or answered with something unusable. The
 * filesystem adapter never raises it — it reads any failure as absence — so it
 * is what a real bucket's adapter owes the contract.
 */
export class ObjectStoreUnavailable extends Schema.TaggedError<ObjectStoreUnavailable>()(
  'ObjectStoreUnavailable',
  { key: Schema.String, message: Schema.String },
) {}

export type ObjectStoreError = PreconditionFailed | ObjectStoreUnavailable;

export interface StoredObject {
  readonly key: ObjectKey;
  readonly body: ObjectBody;
  readonly etag: ETag;
}

export interface ListOptions {
  /** Only keys carrying this prefix. */
  readonly prefix?: string;
  readonly limit?: number;
  /** Resume an earlier listing: the last key handed out. */
  readonly cursor?: string;
}

export interface ObjectListing {
  readonly keys: ReadonlyArray<ObjectKey>;
  /** Present when more keys follow; hand it back as `cursor`. */
  readonly cursor?: string;
}
