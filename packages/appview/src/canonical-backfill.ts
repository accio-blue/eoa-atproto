import { Effect, Schema } from 'effect';
import { type CanonicalStoreShape } from './canonical-store.js';

/**
 * The canonical store's history half: crawl a repository's records off its PDS
 * into `CanonicalStore`.
 *
 * Our relays are non-archival, so when the AppView starts it only holds what
 * the live stream has carried since that moment; everything older has to be
 * read from the PDS itself. A whole-repo walk here is per collection, the same
 * shape `pds-source.ts` uses for the backlink index: `com.atproto.repo.describeRepo`
 * names the collections, and `com.atproto.repo.listRecords` pages one of them
 * with a cursor. Unlike `pds-source`, which keeps only an `ObservedRecord` and
 * drops the CID, this crawl keeps the `{ uri, cid, value }` envelope the
 * canonical store is keyed and served by.
 *
 * Pages are applied with `store.apply` directly: the sequence and order records
 * apply in is the ingestion pipeline's rule (`ingestion-pipeline.ts`), not a
 * bulk load's - this is one repository, page by page, not the live stream.
 *
 * ponytail: no durable cursor. A failed page fails the walk and the caller
 * retries or resumes from the start; drive the run from `backfill-cursor.ts`
 * (and carry the remaining walk as `pds-source.ts`'s cursor does) once a
 * durable resume point is needed.
 */

export class CanonicalBackfillError extends Schema.TaggedError<CanonicalBackfillError>()(
  'CanonicalBackfillError',
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

const ListPageJson = Schema.fromJsonString(ListPageSchema);
const DescribeRepoJson = Schema.fromJsonString(DescribeRepoSchema);

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

/** The response body, or a `CanonicalBackfillError` - a non-2xx is not a page. */
const fetchText = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url),
      catch: (cause) =>
        new CanonicalBackfillError({
          message: `GET ${url} failed: ${String(cause)}`,
        }),
    });
    if (!response.ok) {
      return yield* new CanonicalBackfillError({
        message: `GET ${url} failed: ${response.status} ${response.statusText}`,
      });
    }
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new CanonicalBackfillError({
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
          new CanonicalBackfillError({
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
          new CanonicalBackfillError({
            message: `listRecords for ${params.did}/${params.collection} returned an unexpected shape: ${String(cause)}`,
          }),
      ),
    );
  });

/** One collection, page by page: apply each envelope, then follow the cursor. */
const applyCollection: (params: {
  readonly store: CanonicalStoreShape;
  readonly baseUrl: string;
  readonly did: string;
  readonly collection: string;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
}) => Effect.Effect<number, CanonicalBackfillError> = (params) =>
  listRecords(params).pipe(
    Effect.flatMap((page) =>
      Effect.forEach(page.records, (record) => params.store.apply(record)).pipe(
        Effect.as(page.records.length),
        Effect.flatMap((applied) =>
          page.cursor === undefined
            ? Effect.succeed(applied)
            : applyCollection({ ...params, cursor: page.cursor }).pipe(
                Effect.map((rest) => applied + rest),
              ),
        ),
      ),
    ),
  );

/** Walk every collection, page by page, applying each `{ uri, cid, value }`. */
export const backfillCanonical: (params: {
  readonly store: CanonicalStoreShape;
  readonly pdsUrl: string;
  readonly did: string;
  /** Page size per listRecords call. */
  readonly limit?: number | undefined;
}) => Effect.Effect<{ readonly applied: number }, CanonicalBackfillError> = (
  params,
) => {
  const baseUrl = params.pdsUrl.replace(/\/+$/, '');

  return Effect.gen(function* () {
    const collections = yield* collectionsOf({ baseUrl, did: params.did });
    const applied = yield* Effect.forEach(collections, (collection) =>
      applyCollection({
        store: params.store,
        baseUrl,
        did: params.did,
        collection,
        limit: params.limit,
        cursor: undefined,
      }),
    );
    return { applied: applied.reduce((total, count) => total + count, 0) };
  });
};
