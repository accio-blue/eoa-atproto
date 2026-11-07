import { type CarReadError, readCar } from '@eoa/repo-store';
import {
  type CommitEvent,
  type FirehoseShape,
  type FutureCursorError,
  type OutdatedCursorError,
  type SpaceCommitEvent,
} from './firehose.js';
import { Effect, Result, Schema, Stream } from 'effect';
import { type XrpcError } from '@eoa/xrpc-server';
import { decodeCbor } from '@eoa/core';
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
 *
 * **A space is the same stream with a `?space=` query.** One subscription may name the spaces the
 * caller follows; each frame then carries `space` and the record as JSON, from the firehose's one
 * window and one `time_us` order. No `?space=` is the public stream exactly as before — no
 * credential, no space events, the same frames.
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
  /**
   * The spaces this subscription carries, from repeated `?space=`. Absent is the public stream; a
   * list is a space stream, gated and served from the same window.
   */
  readonly spaces?: readonly string[] | undefined;
};

/**
 * The space-mode gate, supplied by the spaces surface: `void` when this caller may read the space,
 * an `XrpcError` (401 or 403) when the endpoint must refuse before it writes a frame.
 */
export type JetstreamSpaceGate = (
  space: string,
) => Effect.Effect<void, XrpcError>;

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

/** Whether a space event survives the query's record filters, which apply to a space as they do to
 * a public commit. */
const spaceWanted = (event: SpaceCommitEvent, filter: JetstreamFilter) =>
  (filter.wantedDids === undefined || filter.wantedDids.includes(event.did)) &&
  (filter.wantedCollections === undefined ||
    filter.wantedCollections.includes(event.collection));

/**
 * The Jetstream stream over a firehose: resume where the client left off, then follow. A cursor the
 * firehose refuses (`FutureCursor`, `OutdatedCursor`) is the stream's failure, and the endpoint
 * answers it with a status rather than by starting a response it cannot keep.
 *
 * Naming spaces switches the source, not the shape: the space tail is one subscription over a set of
 * spaces, so the frames come in the window's `time_us` order, and a space event is already the JSON
 * a client reads (`SpaceCommitEvent` carries `space`).
 */
export const jetstreamStream = (params: {
  readonly firehose: FirehoseShape;
  readonly filter: JetstreamFilter;
  readonly cursor?: number | undefined;
  readonly spaces?: readonly string[] | undefined;
}): Stream.Stream<
  JetstreamFrame | SpaceCommitEvent,
  CarReadError | MissingBlockError | FutureCursorError | OutdatedCursorError
> => {
  const { firehose, filter, cursor, spaces } = params;

  if (spaces !== undefined && spaces.length > 0) {
    return firehose
      .subscribeSpaces({ spaces, cursor })
      .pipe(Stream.filter((event) => spaceWanted(event, filter)));
  }

  return firehose.subscribe({ cursor }).pipe(
    Stream.flatMap((event) =>
      // Jetstream addresses records: an identity event carries none, and a
      // consumer that hears it re-resolves the DID through its own resolver.
      event.kind === 'identity'
        ? Stream.empty
        : Stream.fromIterableEffect(jetstreamFrames({ event, filter })),
    ),
  );
};

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
    // Repeated `?space=` names a set: one subscription may follow several spaces, in the firehose's
    // own order.
    spaces: wanted('space'),
  } satisfies JetstreamQuery;
};

/** Where a deployment serves Jetstream, beside `/xrpc` rather than under it. */
export const JETSTREAM_PATH = '/jetstream/subscribe';

/**
 * A refusal before the body starts: a status and a sentence, and not a frame.
 *
 * The sentence is `text/plain`, exactly like `cursorRefusal`'s, because a reader of NDJSON must not
 * find a line it cannot parse, and a status text does not survive every transport. Same rule as a
 * cursor: a stream that dies after its first byte is indistinguishable from a bad network.
 */
const refusal = (status: number, message: string) =>
  new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

/**
 * `GET /jetstream/subscribe` as a `Response`: NDJSON frames that follow the firehose, or a refusal
 * before the body when this caller may not have it.
 *
 * Public mode names no space and takes no credential, exactly as before. Space mode asks `gate` once
 * per named space first — no credential is a 401, a space the caller may not read a 403 naming it —
 * and only then starts a response it can keep.
 */
export const jetstreamResponse = (params: {
  readonly firehose: FirehoseShape;
  readonly url: URL;
  /**
   * The one gate the space socket also passes. Absent means this endpoint serves only the public
   * stream, and a request that names a space is refused rather than served ungated.
   */
  readonly gate?: JetstreamSpaceGate | undefined;
}) =>
  Effect.gen(function* () {
    const query = jetstreamQuery(params.url.searchParams);
    const spaces = query.spaces;
    if (spaces !== undefined && spaces.length > 0) {
      if (params.gate === undefined) {
        return refusal(
          401,
          'a space stream needs a session, or a space credential with its proof',
        );
      }
      for (const space of spaces) {
        const admitted = yield* Effect.result(params.gate(space));
        if (Result.isFailure(admitted)) {
          return refusal(admitted.failure.status, admitted.failure.message);
        }
      }
    }

    const refusalText = yield* cursorRefusal(params.firehose, query.cursor);
    if (refusalText !== undefined) {
      return refusal(400, refusalText);
    }
    const encoder = new TextEncoder();
    const body = jetstreamStream({
      firehose: params.firehose,
      filter: query.filter,
      cursor: query.cursor,
      ...(spaces === undefined ? {} : { spaces }),
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
