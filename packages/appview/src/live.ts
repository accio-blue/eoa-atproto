import { type CborValue, asCborValue } from '@eoa/core';
import { Effect, Schema, Stream } from 'effect';
import { type IndexStoreShape } from './index-store.js';
import { indexRecord } from './ingest.js';

/**
 * The live side of the backlink index: consume our own Jetstream endpoint and
 * index the frames it serves, resumably.
 *
 * The endpoint (`packages/atproto-pds/src/jetstream.ts`, `jetstreamResponse`) is NDJSON over HTTP:
 * one frame per line, each commit reduced to one record operation. This is the
 * client - it dials `GET /subscribe`, splits the body into lines, decodes each
 * line, and folds the frames into the store. The cursor is the last `time_us`
 * applied; a frame at or below it was applied on a previous connection and is
 * skipped, so a reconnect resumes instead of replaying and the request cursor
 * never passes an unseen record.
 *
 * Nothing here decides *when* to reconnect or back off. That is the caller's,
 * and `@eoa/sync` already models it in `subscription-cursor.ts`; this
 * module is the transport and the fold, not the reconnect policy.
 */

/** One frame reduced to what the index needs. */
export type IndexFrame = {
  readonly did: string;
  readonly time_us: number;
  readonly collection: string;
  readonly rkey: string;
  readonly operation: string;
  /** The record's CID; absent on a delete, which has no record. */
  readonly cid?: string | undefined;
  readonly record?: CborValue | undefined;
};

export class LiveIngestError extends Schema.TaggedError<LiveIngestError>()(
  'LiveIngestError',
  { message: Schema.String },
) {}

/** A frame as the endpoint serves it: the record is JSON on the wire. */
const WireFrame = Schema.Struct({
  did: Schema.String,
  time_us: Schema.Finite,
  kind: Schema.Literal('commit'),
  commit: Schema.Struct({
    operation: Schema.String,
    cid: Schema.optionalKey(Schema.String),
    collection: Schema.String,
    rkey: Schema.String,
    record: Schema.optionalKey(Schema.Json),
  }),
});

const WireFrameJson = Schema.fromJsonString(WireFrame);

/** A wire frame reduced to an index frame, its JSON record back in CBOR space. */
const frameOfWire = (wire: Schema.Schema.Type<typeof WireFrame>) => ({
  did: wire.did,
  time_us: wire.time_us,
  collection: wire.commit.collection,
  rkey: wire.commit.rkey,
  operation: wire.commit.operation,
  cid: wire.commit.cid,
  record:
    wire.commit.record === undefined
      ? undefined
      : asCborValue(wire.commit.record),
});

/** One NDJSON line decoded, or a `LiveIngestError` when it is not a frame. */
const decodeFrame = (line: string) =>
  Schema.decodeUnknownEffect(WireFrameJson)(line).pipe(
    Effect.mapError(
      (cause) =>
        new LiveIngestError({ message: `unreadable frame: ${String(cause)}` }),
    ),
    Effect.map(frameOfWire),
  );

/** The NDJSON body of our own endpoint, as frames, resumable from `cursor`. */
export const framesOfEndpoint: (params: {
  readonly url: string;
  readonly cursor?: number | undefined;
}) => Stream.Stream<IndexFrame, LiveIngestError> = (params) => {
  const url = new URL(params.url);
  if (params.cursor !== undefined) {
    url.searchParams.set('cursor', String(params.cursor));
  }

  return Stream.unwrap(
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => fetch(url),
        catch: (cause) =>
          new LiveIngestError({
            message: `GET ${url} failed: ${String(cause)}`,
          }),
      });
      if (!response.ok) {
        return yield* new LiveIngestError({
          message: `GET ${url} failed: ${response.status} ${response.statusText}`,
        });
      }

      const body = response.body;
      if (body === null) {
        return Stream.empty;
      }

      return Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) =>
          new LiveIngestError({
            message: `reading ${url} failed: ${String(cause)}`,
          }),
      }).pipe(
        // `splitLines` carries a partial trailing line to the end, so a body
        // that stops mid-line still yields a frame to decode (or to reject).
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapEffect(decodeFrame),
      );
    }),
  );
};

/** Index frames, returning the cursor reached: the last `time_us` applied.
 *  A frame at or below `cursor` was already applied on a previous connection
 *  and is skipped - that is what makes the stream resumable rather than
 *  at-least-once. */
export const ingestFrames: (params: {
  readonly store: IndexStoreShape;
  readonly frames: Stream.Stream<IndexFrame, LiveIngestError>;
  readonly cursor?: number | undefined;
}) => Effect.Effect<
  { readonly cursor: number; readonly indexed: number },
  LiveIngestError
> = (params) =>
  Stream.runFoldEffect(
    params.frames,
    () => ({ cursor: params.cursor, indexed: 0 }),
    (state, frame) => {
      // `cursor` is the running high-water mark, so a replayed or duplicated
      // frame inside one connection is skipped the same way a resumed one is.
      if (state.cursor !== undefined && frame.time_us <= state.cursor) {
        return Effect.succeed(state);
      }

      return indexRecord({
        store: params.store,
        observed: {
          did: frame.did,
          collection: frame.collection,
          rkey: frame.rkey,
          record: frame.record,
        },
      }).pipe(
        Effect.as({
          cursor: frame.time_us,
          indexed: state.indexed + 1,
        }),
      );
    },
  ).pipe(
    Effect.map((state) => ({
      cursor: state.cursor ?? 0,
      indexed: state.indexed,
    })),
  );
