import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { BlobStore } from './blob-store.js';
import { blobStoreR2Layer } from './blob-store-r2.js';

// Blobs on a bucket, and the case that made this a port rather than a second implementation: an
// artwork is bigger than the value a Durable Object's storage will hold (128 KiB), so a store that
// keeps whole blobs as values cannot serve the pilot at all.

const DID = 'did:plc:kocharin';

/** An in-memory bucket, which is all the port needs to be exercised. */
const bucketOf = () => {
  const held = new Map<string, Uint8Array>();
  return {
    held,
    bucket: {
      put: async (key: string, value: Uint8Array) => {
        held.set(key, value);
        return { key };
      },
      get: async (key: string) => {
        const found = held.get(key);
        return found === undefined
          ? null
          : { arrayBuffer: async () => found.slice().buffer };
      },
      list: async ({ prefix }: { readonly prefix: string }) => ({
        objects: [...held.keys()].flatMap((key) =>
          key.startsWith(prefix) ? [{ key }] : [],
        ),
      }),
    },
  };
};

describe('atproto-pds: blobs on a bucket', () => {
  it('stores an artwork that no Durable Object value could hold', async () => {
    const { held: stored, bucket } = bucketOf();
    // 200 KiB: over the 128 KiB a Durable Object value is capped at, which is the whole reason.
    const bytes = new Uint8Array(200 * 1024).fill(7);

    const held = await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        const uploaded = yield* blobs.upload({
          did: DID,
          bytes,
          mimeType: 'image/jpeg',
          limit: 10 * 1024 * 1024,
          now: 1000,
        });
        if (uploaded._tag !== 'stored') {
          throw new Error(`the upload was refused: ${uploaded._tag}`);
        }
        const read = yield* blobs.content(DID, uploaded.blob.cid);
        const listed = yield* blobs.list(DID);
        return {
          cid: uploaded.blob.cid,
          size: uploaded.blob.size,
          // What a fetch would hand back: nothing is a case, not a failure.
          read: Option.getOrUndefined(read),
          listed: listed.length,
        };
      }).pipe(Effect.provide(blobStoreR2Layer(bucket))),
    );

    expect(held.size).toBe(bytes.length);
    // A raw multihash over the bytes, which is what makes the CID a blob's identity.
    expect(held.cid.startsWith('bafkrei')).toBe(true);
    // And the bytes come back as they went in, at the size that matters.
    expect(held.read?.length).toBe(bytes.length);
    expect(held.read?.[0]).toBe(7);
    expect(held.listed).toBe(1);
    // Two objects: the bytes, and the small facts that make a listing cheap.
    expect([...stored.keys()].sort()).toEqual([
      `B/${DID}/${held.cid}`,
      `BM/${DID}/${held.cid}`,
    ]);
  });
});
