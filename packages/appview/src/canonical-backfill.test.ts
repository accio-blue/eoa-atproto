import {
  CanonicalBackfillError,
  backfillCanonical,
} from './canonical-backfill.js';
import {
  type CanonicalRecord,
  CanonicalStore,
  type CanonicalStoreShape,
  canonicalStoreLayer,
} from './canonical-store.js';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

/**
 * The backfill's contract against a real `CanonicalStore` and a stub PDS on a
 * `node:http` socket (not a stubbed global `fetch`), so the collection walk and
 * the cursor round-trip are exercised over a connection. The store is a
 * `Layer.effect`, rebuilt per `provide`, so every scenario runs inside one
 * provided scope, which the stub is closed from.
 */

const DID = 'did:plc:alice';
const POST = 'app.bsky.feed.post';
const LIKE = 'app.bsky.feed.like';

/** A JSON response body, encoded without the banned global `JSON`. */
const jsonBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const postUri = (rkey: string) => `at://${DID}/${POST}/${rkey}`;

const post = (rkey: string) =>
  ({
    uri: postUri(rkey),
    cid: `bafy-${rkey}`,
    value: { $type: POST, text: rkey },
  }) satisfies CanonicalRecord;

const like = (rkey: string) =>
  ({
    uri: `at://${DID}/${LIKE}/${rkey}`,
    cid: `bafy-${rkey}`,
    value: { $type: LIKE, subject: { uri: postUri('a') } },
  }) satisfies CanonicalRecord;

const POSTS = [post('a'), post('b'), post('c')];
const LIKES = [like('x'), like('y'), like('z')];

/** More records than the page limit, so every collection pages at least twice. */
const FIXTURE = {
  [POST]: POSTS,
  [LIKE]: LIKES,
} satisfies Readonly<Record<string, ReadonlyArray<CanonicalRecord>>>;

/**
 * A stub PDS on an ephemeral port: `describeRepo` names `collections` and
 * `listRecords` pages `records` by the caller's `limit`, returning the next
 * index as an opaque cursor until the collection is exhausted.
 */
const startStubPds = async (params: {
  readonly collections: ReadonlyArray<string>;
  readonly records: Readonly<Record<string, ReadonlyArray<CanonicalRecord>>>;
  readonly listRecordsStatus?: number | undefined;
}) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (out: { readonly status: number; readonly body: unknown }) => {
      response.writeHead(out.status, { 'content-type': 'application/json' });
      response.end(jsonBody(out.body));
    };

    if (url.pathname.endsWith('describeRepo')) {
      send({
        status: 200,
        body: { did: DID, collections: params.collections },
      });
      return;
    }

    if (
      params.listRecordsStatus !== undefined &&
      params.listRecordsStatus !== 200
    ) {
      send({ status: params.listRecordsStatus, body: { error: 'nope' } });
      return;
    }

    const collection = url.searchParams.get('collection') ?? '';
    const records = params.records[collection] ?? [];
    const cursor = url.searchParams.get('cursor');
    const start = cursor === null ? 0 : Number(cursor);
    const limit = Number(url.searchParams.get('limit') ?? records.length);
    const page = records.slice(start, start + limit);
    const next = start + page.length;

    send({
      status: 200,
      body:
        next < records.length
          ? { records: page, cursor: String(next) }
          : { records: page },
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the stub PDS did not bind a port');
  }

  return {
    pdsUrl: `http://127.0.0.1:${address.port}`,
    close: Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
      catch: (cause) =>
        new Error(`closing the stub PDS failed: ${String(cause)}`),
    }).pipe(Effect.ignore),
  };
};

/** Run one scenario against a fresh store, closing the stub when it finishes. */
const runBackfill = <A, E>(params: {
  readonly pdsUrl: string;
  readonly close: Effect.Effect<void>;
  readonly use: (store: CanonicalStoreShape) => Effect.Effect<A, E>;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CanonicalStore;
      return yield* params.use(store);
    }).pipe(Effect.provide(canonicalStoreLayer), Effect.ensuring(params.close)),
  );

describe('backfillCanonical', () => {
  it('applies every record of every collection, paging with the cursor', async () => {
    const stub = await startStubPds({
      collections: [POST, LIKE],
      records: FIXTURE,
    });

    const outcome = await runBackfill({
      pdsUrl: stub.pdsUrl,
      close: stub.close,
      use: (store) =>
        Effect.gen(function* () {
          const { applied } = yield* backfillCanonical({
            store,
            pdsUrl: stub.pdsUrl,
            did: DID,
            limit: 2,
          });
          return { applied, size: yield* store.size };
        }),
    });

    expect(outcome.applied).toBe(6);
    expect(outcome.size).toBe(6);
  });

  it('holds the exact { uri, cid, value } envelopes', async () => {
    const stub = await startStubPds({
      collections: [POST, LIKE],
      records: FIXTURE,
    });

    const held = await runBackfill({
      pdsUrl: stub.pdsUrl,
      close: stub.close,
      use: (store) =>
        Effect.gen(function* () {
          yield* backfillCanonical({
            store,
            pdsUrl: stub.pdsUrl,
            did: DID,
            limit: 2,
          });
          const posts = yield* Effect.forEach(POSTS, (record) =>
            store.get(record.uri),
          );
          const likes = yield* Effect.forEach(LIKES, (record) =>
            store.get(record.uri),
          );
          return { posts, likes };
        }),
    });

    expect(held.posts).toEqual(POSTS);
    expect(held.likes).toEqual(LIKES);
  });

  it('yields applied 0 for a repository with no records and does not fail', async () => {
    const stub = await startStubPds({
      collections: [POST],
      records: { [POST]: [] },
    });

    const result = await runBackfill({
      pdsUrl: stub.pdsUrl,
      close: stub.close,
      use: (store) =>
        backfillCanonical({
          store,
          pdsUrl: stub.pdsUrl,
          did: DID,
          limit: 2,
        }),
    });

    expect(result.applied).toBe(0);
  });

  it('fails with CanonicalBackfillError when listRecords returns 500', async () => {
    const stub = await startStubPds({
      collections: [POST],
      records: FIXTURE,
      listRecordsStatus: 500,
    });

    const error = await runBackfill({
      pdsUrl: stub.pdsUrl,
      close: stub.close,
      use: (store) =>
        Effect.flip(
          backfillCanonical({
            store,
            pdsUrl: stub.pdsUrl,
            did: DID,
            limit: 2,
          }),
        ),
    });

    expect(error).toBeInstanceOf(CanonicalBackfillError);
  });
});
