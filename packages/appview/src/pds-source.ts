import { Effect, Schema } from 'effect';
import { type ObservedRecord, indexRecord } from './ingest.js';
import { type IndexStoreShape } from './index-store.js';
import { asCborValue } from '@eoa/core';

/**
 * The PDS backfill source: a repository's history, page by page.
 *
 * Our relays are non-archival, so the past cannot be read off the live stream -
 * it has to be crawled from the PDSes themselves. `com.atproto.repo.listRecords`
 * is scoped to one collection, so a whole-repo walk is per collection: the
 * names come from `com.atproto.repo.describeRepo`, and the cursor this source
 * returns carries the remaining walk - the collection list, the position in it,
 * and the listing cursor inside the current collection. A caller that only
 * holds the cursor can therefore resume without re-describing the repo.
 *
 * This is only the reading half. The ordinals and the reconciliation with the
 * live stream are `backfill-live`'s, and the loop that drives them - start,
 * page, hand over, drain - is the next slice; nothing here decides when a page
 * is applied.
 */

export interface BackfillPage {
  readonly records: readonly ObservedRecord[];
  readonly cursor?: string | undefined;
}

/** A repository's records, page by page - the historical side of the index. */
export interface BackfillSourceShape {
  readonly pageOf: (params: {
    readonly did: string;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<BackfillPage, BackfillSourceError>;
}

export class BackfillSourceError extends Schema.TaggedError<BackfillSourceError>()(
  'BackfillSourceError',
  { message: Schema.String },
) {}

const LIST_RECORDS = '/xrpc/com.atproto.repo.listRecords';
const DESCRIBE_REPO = '/xrpc/com.atproto.repo.describeRepo';

const EnvelopeSchema = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  value: Schema.Json,
});

const ListPageSchema = Schema.Struct({
  records: Schema.Array(EnvelopeSchema),
  cursor: Schema.optionalKey(Schema.String),
});

const DescribeRepoSchema = Schema.Struct({
  collections: Schema.Array(Schema.String),
});

/** What a cursor carries: the remaining collections and where the walk is. */
const WalkSchema = Schema.Struct({
  collections: Schema.Array(Schema.String),
  index: Schema.Number,
  cursor: Schema.optionalKey(Schema.String),
});

type Walk = Schema.Schema.Type<typeof WalkSchema>;

const ListPageJson = Schema.fromJsonString(ListPageSchema);
const DescribeRepoJson = Schema.fromJsonString(DescribeRepoSchema);
const WalkJson = Schema.fromJsonString(WalkSchema);

/** One XRPC GET, with its query pairs, as an absolute URL. */
const xrpcUrl = (params: {
  readonly baseUrl: string;
  readonly method: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
}) => {
  const url = new URL(`${params.baseUrl}${params.method}`);
  params.query.forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
};

/** The response body, or a `BackfillSourceError` - a non-2xx is not a page. */
const fetchText = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url),
      catch: (cause) =>
        new BackfillSourceError({
          message: `GET ${url} failed: ${String(cause)}`,
        }),
    });
    if (!response.ok) {
      return yield* new BackfillSourceError({
        message: `GET ${url} failed: ${response.status} ${response.statusText}`,
      });
    }
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new BackfillSourceError({
          message: `reading ${url} failed: ${String(cause)}`,
        }),
    });
  });

const collectionsOf = (params: {
  readonly baseUrl: string;
  readonly did: string;
}) =>
  Effect.gen(function* () {
    const text = yield* fetchText(
      xrpcUrl({
        baseUrl: params.baseUrl,
        method: DESCRIBE_REPO,
        query: [['repo', params.did]],
      }),
    );
    const described = yield* Schema.decodeUnknownEffect(DescribeRepoJson)(
      text,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BackfillSourceError({
            message: `describeRepo for ${params.did} returned an unexpected shape: ${String(cause)}`,
          }),
      ),
    );
    return described.collections;
  });

const listRecords = (params: {
  readonly baseUrl: string;
  readonly did: string;
  readonly collection: string;
  readonly cursor: string | undefined;
  readonly limit: number | undefined;
}) =>
  Effect.gen(function* () {
    const query: Array<readonly [string, string]> = [
      ['repo', params.did],
      ['collection', params.collection],
    ];
    if (params.cursor !== undefined) {
      query.push(['cursor', params.cursor]);
    }
    if (params.limit !== undefined) {
      query.push(['limit', String(params.limit)]);
    }

    const text = yield* fetchText(
      xrpcUrl({ baseUrl: params.baseUrl, method: LIST_RECORDS, query }),
    );
    return yield* Schema.decodeUnknownEffect(ListPageJson)(text).pipe(
      Effect.mapError(
        (cause) =>
          new BackfillSourceError({
            message: `listRecords for ${params.did}/${params.collection} returned an unexpected shape: ${String(cause)}`,
          }),
      ),
    );
  });

const firstWalk: (collections: readonly string[]) => Walk = (collections) => ({
  collections,
  index: 0,
});

/** The cursor for the next call: inner cursor first, then the next collection. */
const advance = (params: {
  readonly walk: Walk;
  readonly cursor: string | undefined;
}) => {
  if (params.cursor !== undefined) {
    return Schema.encodeSync(WalkJson)({
      collections: params.walk.collections,
      index: params.walk.index,
      cursor: params.cursor,
    });
  }
  return params.walk.index + 1 < params.walk.collections.length
    ? Schema.encodeSync(WalkJson)({
        collections: params.walk.collections,
        index: params.walk.index + 1,
      })
    : undefined;
};

const observedOf = (params: {
  readonly did: string;
  readonly collection: string;
  readonly envelope: Schema.Schema.Type<typeof EnvelopeSchema>;
}) => ({
  did: params.did,
  collection: params.collection,
  rkey: params.envelope.uri.slice(params.envelope.uri.lastIndexOf('/') + 1),
  record: asCborValue(params.envelope.value),
});

/** The live source: `com.atproto.repo.listRecords` over HTTP. */
export const pdsBackfillSource: (config: {
  readonly baseUrl: string;
}) => BackfillSourceShape = (config) => {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');

  return {
    pageOf: (params) =>
      Effect.gen(function* () {
        const walk =
          params.cursor === undefined
            ? firstWalk(yield* collectionsOf({ baseUrl, did: params.did }))
            : yield* Schema.decodeUnknownEffect(WalkJson)(params.cursor).pipe(
                Effect.mapError(
                  (cause) =>
                    new BackfillSourceError({
                      message: `unreadable backfill cursor for ${params.did}: ${String(cause)}`,
                    }),
                ),
              );

        const collection = walk.collections[walk.index];
        if (collection === undefined) {
          return { records: [] };
        }

        const listed = yield* listRecords({
          baseUrl,
          did: params.did,
          collection,
          cursor: walk.cursor,
          limit: params.limit,
        });
        const records = listed.records.map((envelope) =>
          observedOf({ did: params.did, collection, envelope }),
        );
        const cursor = advance({ walk, cursor: listed.cursor });

        return cursor === undefined ? { records } : { records, cursor };
      }),
  };
};

/** Index one page of history into the store, returning the targets offered. */
export const indexPage: (params: {
  readonly store: IndexStoreShape;
  readonly page: BackfillPage;
}) => Effect.Effect<readonly string[]> = (params) =>
  Effect.gen(function* () {
    const targets = yield* Effect.forEach(params.page.records, (observed) =>
      indexRecord({ store: params.store, observed }),
    );
    return targets.flat();
  });
