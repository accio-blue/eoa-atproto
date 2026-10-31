import { type CommitEvent, type FirehoseShape } from './firehose.js';
import { Effect, Schema, Stream } from 'effect';
import { decodeCbor } from '@eoa/core';
import { readCar } from '@eoa/repo-store';
import { toJson } from './repo.js';

/**
 * Jetstream: the firehose as a JSON stream, filtered by collection and DID, and resumable from the
 * cursor a client last saw.
 *
 * The atproto-native firehose (`com.atproto.sync.subscribeRepos`) is CARs over a socket: a consumer
 * has to read blocks to see a record. Jetstream addresses *records* instead -- one commit with three
 * operations is three frames, each a record as JSON with its CID -- which is what the AppView, a
 * backlink index, and the ecosystem tools that take "a Jetstream endpoint" (Constellation, Spacedust)
 * actually consume. It is one translation, done once, over the same firehose.
 *
 * Served as NDJSON over HTTP rather than JSON over a WebSocket: same frames, same filters, same
 * cursor, one HTTP reader instead of a socket. The divergence is the transport and nothing else.
 */

/** A record as the wire carries it: JSON, and nothing else. */
type Json = Schema.Schema.Type<typeof Schema.Json>;

/** One record operation, in the shape a Jetstream client reads. */
export type JetstreamCommit = {
  readonly rev: string;
  readonly operation: 'create' | 'update' | 'delete';
  readonly collection: string;
  readonly rkey: string;
  /** The record, for a create or update. Absent on a delete, which has none. */
  readonly record?: Json | undefined;
  readonly cid?: string | undefined;
};

/** One frame: a record operation, and where in the stream it happened. */
export type JetstreamFrame = {
  readonly did: string;
  readonly time_us: number;
  readonly kind: 'commit';
  readonly commit: JetstreamCommit;
};

/** What a subscriber asks for. Both empty means everything. */
export type JetstreamFilter = {
  readonly wantedCollections?: readonly string[] | undefined;
  readonly wantedDids?: readonly string[] | undefined;
};

/** A query, as the endpoint receives it. */
export type JetstreamQuery = {
  readonly filter: JetstreamFilter;
  readonly cursor?: number | undefined;
};

/** Reported when a commit names a block its CAR does not carry. */
export class MissingBlockError extends Schema.TaggedError<MissingBlockError>()(
  'MissingBlockError',
  { cid: Schema.String },
) {}

const recordParts = (path: string) => {
  const cut = path.indexOf('/');
  return cut < 0
    ? { collection: path, rkey: '' }
    : { collection: path.slice(0, cut), rkey: path.slice(cut + 1) };
};

/**
 * One commit event, as the frames a Jetstream client reads.
 *
 * A delete carries no record: there is nothing left to carry, and a frame that named a deleted
 * record's value would be a lie about the repository. A commit that names a block it did not bring
 * is a different matter -- that is a store saying something untrue, and it fails rather than emits a
 * frame the consumer cannot use.
 */
export const jetstreamFrames = (params: {
  readonly event: CommitEvent;
  readonly filter: JetstreamFilter;
}) =>
  Effect.gen(function* () {
    const { event, filter } = params;

    if (
      filter.wantedDids !== undefined &&
      !filter.wantedDids.includes(event.did)
    ) {
      return [];
    }

    const car = yield* readCar(event.blocks);
    const frames: JetstreamFrame[] = [];

    for (const op of event.ops) {
      const { collection, rkey } = recordParts(op.path);
      if (
        filter.wantedCollections !== undefined &&
        !filter.wantedCollections.includes(collection)
      ) {
        continue;
      }

      const commit = {
        rev: event.rev,
        operation: op.action,
        collection,
        rkey,
      } satisfies JetstreamCommit;

      if (op.cid === null) {
        frames.push({
          did: event.did,
          time_us: event.timeUs,
          kind: 'commit',
          commit,
        });
        continue;
      }

      const block = car.blocks.get(op.cid);
      if (block === undefined) {
        return yield* new MissingBlockError({ cid: op.cid });
      }

      frames.push({
        did: event.did,
        time_us: event.timeUs,
        kind: 'commit',
        commit: {
          ...commit,
          record: toJson(decodeCbor(block.bytes)),
          cid: op.cid,
        },
      });
    }

    return frames;
  });

/**
 * The Jetstream stream over a firehose: resume where the client left off, then follow. A cursor the
 * firehose refuses (`FutureCursor`, `OutdatedCursor`) is the stream's failure, and the endpoint
 * answers it with a status rather than by starting a response it cannot keep.
 */
export const jetstreamStream = (params: {
  readonly firehose: FirehoseShape;
  readonly filter: JetstreamFilter;
  readonly cursor?: number | undefined;
}) =>
  params.firehose.subscribe({ cursor: params.cursor }).pipe(
    Stream.flatMap((event) =>
      // Jetstream addresses records: an identity event carries none, and a
      // consumer that hears it re-resolves the DID through its own resolver.
      event.kind === 'identity'
        ? Stream.empty
        : Stream.fromIterableEffect(
            jetstreamFrames({ event, filter: params.filter }),
          ),
    ),
  );

/**
 * The sentence an endpoint serves instead of a stream it cannot honour, or `undefined` when the
 * cursor is fine. Served before the response starts, so a client gets a status it can act on rather
 * than a stream that dies halfway.
 */
export const cursorRefusal = (
  firehose: FirehoseShape,
  cursor: number | undefined,
) =>
  firehose.cursorOf(cursor).pipe(
    Effect.asVoid,
    Effect.catchTags({
      FutureCursorError: () =>
        Effect.succeed('the cursor is past the head of the stream'),
      OutdatedCursorError: () =>
        Effect.succeed('the cursor is older than this stream retains'),
    }),
  );

/** The query parameters Jetstream clients use, as this endpoint reads them. */
export const jetstreamQuery = (params: URLSearchParams) => {
  const wanted = (key: string) => {
    const values = params.getAll(key);
    return values.length === 0 ? undefined : values;
  };
  const raw = params.get('cursor');
  const cursor = raw === null ? undefined : Number(raw);

  return {
    filter: {
      wantedCollections: wanted('wantedCollections'),
      wantedDids: wanted('wantedDids'),
    },
    cursor: cursor === undefined || Number.isNaN(cursor) ? undefined : cursor,
  } satisfies JetstreamQuery;
};

/** Where a deployment serves Jetstream, beside `/xrpc` rather than under it. */
export const JETSTREAM_PATH = '/jetstream/subscribe';

/**
 * `GET /jetstream/subscribe` as a `Response`: NDJSON frames that follow the firehose, or a 400 when
 * the cursor cannot be honoured. The refusal comes **before** the body starts, because a stream that
 * dies after its first byte is a client that cannot tell a bad cursor from a quiet network.
 */
export const jetstreamResponse = (firehose: FirehoseShape, url: URL) =>
  Effect.gen(function* () {
    const query = jetstreamQuery(url.searchParams);
    const refusal = yield* cursorRefusal(firehose, query.cursor);
    if (refusal !== undefined) {
      return new Response(`${refusal}\n`, {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const encoder = new TextEncoder();
    const body = jetstreamStream({
      firehose,
      filter: query.filter,
      cursor: query.cursor,
    }).pipe(
      Stream.map((frame): Uint8Array =>
        encoder.encode(`${JSON.stringify(frame)}\n`),
      ),
      Stream.toReadableStream<Uint8Array>(),
    );
    return new Response(body, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  });
