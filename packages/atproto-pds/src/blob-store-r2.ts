import { BlobStore, blobStoreOver } from './blob-store.js';
import { Effect, Layer, Option } from 'effect';
import { KvUnavailable, type Value } from '@eoa/kv';

/**
 * Blobs on a bucket, which is where they have to go when they do not fit.
 *
 * The bytes are content-addressed by CID and written whole: an object store has no value limit to
 * work around, so the two-row shape the KV store uses (`B/` for the bytes, `BM/` for the facts
 * about them) is exactly the shape a bucket wants — one object per blob, and a prefix to list.
 *
 * The port is **structural** rather than the runtime's own binding type, for the same reason
 * `kvDurableLayer` takes a `DurableStorage`: a package that imports a runtime's types is a
 * package that runs in one place.
 */
/** What a bucket answers a write with: where it landed. */
export interface WrittenBlob {
  readonly key: string;
}

export interface BlobBucket {
  readonly put: (key: string, value: Uint8Array) => Promise<WrittenBlob | null>;
  readonly get: (
    key: string,
  ) => Promise<{ readonly arrayBuffer: () => Promise<ArrayBuffer> } | null>;
  readonly list: (options: {
    readonly prefix: string;
  }) => Promise<{ readonly objects: ReadonlyArray<{ readonly key: string }> }>;
}

const unavailable = (what: string, cause: unknown) =>
  new KvUnavailable({ message: `${what}: ${String(cause)}` });

/**
 * The store with its rows in a bucket.
 *
 * `list` reads the facts about each blob one object at a time, because a bucket's listing gives
 * keys and nothing else — and listing a repo's blobs is rare enough that a round trip per blob is
 * the honest price rather than a second index to keep in step.
 */
export const blobStoreR2Layer = (bucket: BlobBucket) =>
  Layer.effect(
    BlobStore,
    blobStoreOver({
      put: (entries: ReadonlyArray<{ key: string; value: Value }>) =>
        Effect.tryPromise({
          try: async () => {
            for (const entry of entries) {
              await bucket.put(entry.key, entry.value);
            }
          },
          catch: (cause) => unavailable('a blob could not be written', cause),
        }),

      get: (key: string) =>
        Effect.tryPromise({
          try: async () => {
            const held = await bucket.get(key);
            return held === null
              ? Option.none<Value>()
              : Option.some(new Uint8Array(await held.arrayBuffer()));
          },
          catch: (cause) => unavailable('a blob could not be read', cause),
        }),

      list: (prefix: string) =>
        Effect.tryPromise({
          try: async () => {
            const held = await bucket.list({ prefix });
            const rows: Array<{ key: string; value: Value }> = [];
            for (const object of held.objects) {
              const found = await bucket.get(object.key);
              if (found === null) {
                continue;
              }
              rows.push({
                key: object.key,
                value: new Uint8Array(await found.arrayBuffer()),
              });
            }
            return rows;
          },
          catch: (cause) => unavailable('the blobs could not be listed', cause),
        }),
    }),
  );
