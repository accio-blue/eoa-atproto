import { Context, type Effect, type Option } from 'effect';
import type {
  ETag,
  ListOptions,
  ObjectBody,
  ObjectKey,
  ObjectListing,
  ObjectStoreError,
  StoredObject,
  WriteConditionMap,
} from './types.js';

/**
 * The object-store contract (the Effect-PDS map, `uasm`).
 *
 * `15kf`'s KV backend codes against this and not against a vendor SDK, so S3,
 * R2 and the filesystem are interchangeable behind one set of guarantees —
 * including the conditional writes the LSM's correctness rests on.
 */
export class ObjectStore extends Context.Service<
  ObjectStore,
  {
    readonly get: (
      key: ObjectKey,
    ) => Effect.Effect<Option.Option<StoredObject>, ObjectStoreError>;
    /** Returns the new object's etag. */
    readonly put: (
      key: ObjectKey,
      body: ObjectBody,
      condition?: WriteConditionMap,
    ) => Effect.Effect<ETag, ObjectStoreError>;
    readonly delete: (
      key: ObjectKey,
      condition?: WriteConditionMap,
    ) => Effect.Effect<void, ObjectStoreError>;
    readonly list: (
      options?: ListOptions,
    ) => Effect.Effect<ObjectListing, ObjectStoreError>;
  }
>()('@eoa/object-store/ObjectStore') {}
