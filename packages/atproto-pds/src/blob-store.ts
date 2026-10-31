import { Context, Data, Effect, Layer, Option, Schema } from 'effect';
import { type CryptoError, sha256 } from '@eoa/crypto';
import { Kv, putOp } from '@eoa/kv';
import type { KvError, Value } from '@eoa/kv';
import { appendChunk, begin, emptySession, finish } from './blob-upload.js';
import { cidFromDigest, formatCid } from '@eoa/core';

/**
 * Blobs on the KV (the Effect-PDS map, `m4jw`).
 *
 * A blob's **identity is its bytes**: the CID is a `raw` multihash over them, so
 * two uploads of the same file are one blob, and the reference a record holds
 * names the content rather than a place. That is why nothing here mints an id —
 * the content is the id, and the rows are keyed by it.
 *
 * Two rows per blob: the bytes under `B/{did}/{cid}`, and the small facts about
 * them (type, size, when) under `BM/{did}/{cid}` — so listing a repo's blobs
 * reads the small rows and never the big ones.
 *
 * The upload itself is `blob-upload.qnt`'s session, driven to completion:
 * `begin`, a chunk at a time, `finish`. A chunk that would exceed the limit
 * fails the session and drops what was kept, which is the spec's rule and also
 * the reason to have one.
 */

/** How much of an upload one chunk is: the machine's rules are per chunk. */
const CHUNK_BYTES = 64 * 1024;

/** An upload as the chunks the machine appends, in the order they arrived. */
const chunksOf = (bytes: Value) =>
  Array.from({ length: Math.ceil(bytes.length / CHUNK_BYTES) }, (_unused, at) =>
    bytes.subarray(at * CHUNK_BYTES, (at + 1) * CHUNK_BYTES),
  );

/** How many rows a single scan will read; a streaming iterator is the next step. */
const SCAN_LIMIT = 10_000;

/**
 * The `raw` codec: a blob's CID is over its bytes themselves, not over a
 * CBOR-encoded value — which is why a blob's reference starts `bafkrei`.
 */
const CODEC_RAW = 0x55;

const bytesKey = (did: string, cid: string) => `B/${did}/${cid}`;

const metaKey = (did: string, cid: string) => `BM/${did}/${cid}`;

const metasUnder = (did: string) => `BM/${did}/`;

/** A row that is there but unreadable. */
export class CorruptBlob extends Schema.TaggedError<CorruptBlob>()(
  'CorruptBlob',
  { key: Schema.String },
) {}

/** A blob, as the store remembers it: never the bytes. */
export interface StoredBlob {
  readonly cid: string;
  readonly did: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: number;
}

const BlobSchema = Schema.Struct({
  cid: Schema.String,
  did: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  createdAt: Schema.Number,
});

const decodeBlob = Schema.decodeUnknownOption(
  Schema.fromJsonString(BlobSchema),
);
const encodeBlob = Schema.encodeSync(Schema.fromJsonString(BlobSchema));

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const utf8 = (value: string) => encoder.encode(value);

const text = (value: Value) => decoder.decode(value);

export interface UploadParams {
  readonly did: string;
  readonly bytes: Value;
  readonly mimeType: string;
  readonly limit: number;
  readonly now: number;
}

/** What an upload did — a refusal is an outcome, not an error. */
export type UploadOutcomeMap = Data.TaggedEnum<{
  readonly stored: { readonly blob: StoredBlob };
  readonly tooLarge: { readonly limit: number };
  readonly empty: {};
}>;

export const {
  stored: uploadStored,
  tooLarge: uploadTooLarge,
  empty: uploadEmpty,
} = Data.taggedEnum<UploadOutcomeMap>();

export type BlobError = CorruptBlob | CryptoError | KvError;

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly upload: (
      params: UploadParams,
    ) => Effect.Effect<UploadOutcomeMap, BlobError>;
    /** What the store remembers about a blob — its bytes are `content`. */
    readonly blob: (
      did: string,
      cid: string,
    ) => Effect.Effect<Option.Option<StoredBlob>, BlobError>;
    readonly content: (
      did: string,
      cid: string,
    ) => Effect.Effect<Option.Option<Value>, BlobError>;
    readonly list: (
      did: string,
    ) => Effect.Effect<ReadonlyArray<StoredBlob>, BlobError>;
  }
>()('@eoa/atproto-pds/BlobStore') {}

/**
 * Where a blob's rows live.
 *
 * A port, and it exists because of a size: a Durable Object's storage caps a value at 128 KiB,
 * and an artwork does not fit — so the bytes want an object store, while the blob store's shape
 * (the CID as the identity, two rows, the upload machine) wants to be exactly the same. The
 * store is written once, over this.
 */
export interface BlobRows {
  readonly put: (
    entries: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  ) => Effect.Effect<void, KvError>;
  readonly get: (key: string) => Effect.Effect<Option.Option<Value>, KvError>;
  readonly list: (
    prefix: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly key: string; readonly value: Value }>,
    KvError
  >;
}

/** The store, over wherever its rows are. */
export const blobStoreOver = (rows: BlobRows) =>
  Effect.gen(function* () {
    /** A blob's identity: a raw multihash over its bytes. */
    const cidOf = (content: Value) =>
      Effect.gen(function* () {
        const digest = yield* sha256(content);
        return formatCid(cidFromDigest({ codec: CODEC_RAW, digest }));
      });

    const upload = (params: UploadParams) =>
      Effect.gen(function* () {
        // The spec's machine, driven over the upload's chunks. What it accepted
        // is the first `bytes` of the upload, so a failure discards the rest by
        // arithmetic rather than by bookkeeping — the spec's `bytes' = 0`.
        //
        // ponytail: the transport has already buffered the body, so a refusal
        // still costs the whole upload in memory. Hand the machine the request
        // stream when uploads can be tens of megabytes.
        const driven = chunksOf(params.bytes).reduce(
          (session, chunk) => appendChunk(session, chunk.length),
          begin(emptySession(params.limit)),
        );
        const finished = finish(driven);
        if (finished.phase === 'failed') {
          return uploadTooLarge({ limit: params.limit });
        }
        if (finished.phase !== 'uploaded') {
          return uploadEmpty();
        }

        const content = params.bytes.subarray(0, finished.bytes);
        const cid = yield* cidOf(content);
        const blob: StoredBlob = {
          cid,
          did: params.did,
          mimeType: params.mimeType,
          size: content.length,
          createdAt: params.now,
        };
        yield* rows.put([
          { key: bytesKey(params.did, cid), value: content },
          { key: metaKey(params.did, cid), value: utf8(encodeBlob(blob)) },
        ]);
        return uploadStored({ blob });
      });

    const blob = (did: string, cid: string) =>
      Effect.gen(function* () {
        const found = yield* rows.get(metaKey(did, cid));
        if (Option.isNone(found)) {
          return Option.none<StoredBlob>();
        }
        const decoded = decodeBlob(text(found.value));
        return Option.isNone(decoded)
          ? yield* Effect.fail(new CorruptBlob({ key: metaKey(did, cid) }))
          : Option.some(decoded.value);
      });

    const content = (did: string, cid: string) =>
      rows
        .get(bytesKey(did, cid))
        .pipe(Effect.map(Option.map((found) => found)));

    const list = (did: string) =>
      Effect.gen(function* () {
        const held = yield* rows.list(metasUnder(did));
        return yield* Effect.forEach(held, (entry) => {
          const decoded = decodeBlob(text(entry.value));
          return Option.isNone(decoded)
            ? Effect.fail(new CorruptBlob({ key: entry.key }))
            : Effect.succeed(decoded.value);
        });
      });

    return BlobStore.of({ upload, blob, content, list });
  });

/**
 * The store on the KV, which is where a blob goes when its bytes fit the values that hold
 * them — the filesystem, the memory, or a Durable Object's storage for a small one.
 */
export const blobStoreLayer = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const kv = yield* Kv;
    return yield* blobStoreOver({
      put: (entries) => kv.batch(entries.map((one) => putOp(one))),
      get: (key) =>
        kv.get(key).pipe(Effect.map(Option.map((entry) => entry.value))),
      list: (prefix) =>
        kv.scan({ prefix, limit: SCAN_LIMIT }).pipe(
          Effect.map((page) =>
            page.entries.map((entry) => ({
              key: entry.key,
              value: entry.value,
            })),
          ),
        ),
    });
  }),
);
