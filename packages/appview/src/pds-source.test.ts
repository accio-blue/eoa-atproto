import {
  type BackfillPage,
  indexPage,
  pdsBackfillSource,
} from './pds-source.js';
import { Effect, Schema } from 'effect';
import { IndexStore, indexStoreLayer } from './index-store.js';
import { describe, expect, it } from 'vitest';
import { type CborValue } from '@eoa/core';
import { createServer } from 'node:http';
import { recordUri } from './ingest.js';

/**
 * The PDS source, both halves: `indexPage` over a hand-built source, and the
 * real `fetch`-based `pdsBackfillSource` against a local `node:http` server
 * (not a stubbed global `fetch`), so the paging and the cursor round-trip are
 * exercised over a socket.
 *
 * The store is a `Layer.effect`, rebuilt on every `provide`, so every scenario
 * that seeds and reads runs inside one provided scope.
 */

const DID = 'did:plc:alice';
const TARGET = 'at://did:plc:bob/app.bsky.feed.post/3k2la9x8w1';

/** A JSON response body, encoded without the banned global `JSON`. */
const jsonBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const observed = (params: {
  readonly collection: string;
  readonly rkey: string;
  readonly record: CborValue;
}) => ({
  did: DID,
  collection: params.collection,
  rkey: params.rkey,
  record: params.record,
});

const envelope = (params: {
  readonly collection: string;
  readonly rkey: string;
  readonly value: unknown;
}) => ({
  uri: `at://${DID}/${params.collection}/${params.rkey}`,
  cid: 'bafyreidfayvfuwqa7qlnopdjiqrxzs',
  value: params.value,
});

describe('indexPage', () => {
  it('files a strongRef under its target across a two-page source', async () => {
    const like = observed({
      collection: 'app.bsky.feed.like',
      rkey: '3like',
      record: {
        $type: 'app.bsky.feed.like',
        subject: { uri: TARGET, cid: 'bafyreidfayvfuwqa7qlnopdjiqrxzs' },
      },
    });
    const first: BackfillPage = { records: [like], cursor: 'second-page' };
    const second: BackfillPage = {
      records: [
        observed({
          collection: 'app.bsky.feed.post',
          rkey: '3post',
          record: { $type: 'app.bsky.feed.post', text: 'nothing here' },
        }),
      ],
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexStore;
        const offered = yield* indexPage({ store, page: first });
        yield* indexPage({ store, page: second });
        const backlinks = yield* store.backlinksOf(TARGET);
        return { offered, backlinks };
      }).pipe(Effect.provide(indexStoreLayer)),
    );

    expect(result.offered).toEqual([TARGET]);
    expect(result.backlinks).toEqual([recordUri(like)]);
  });

  it('yields nothing for a page whose records carry no references', async () => {
    const page: BackfillPage = {
      records: [
        observed({
          collection: 'app.bsky.feed.post',
          rkey: '3quiet',
          record: { $type: 'app.bsky.feed.post', text: 'plain' },
        }),
      ],
    };

    const offered = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexStore;
        return yield* indexPage({ store, page });
      }).pipe(Effect.provide(indexStoreLayer)),
    );

    expect(offered).toEqual([]);
  });
});

describe('pdsBackfillSource', () => {
  it('walks a repo collection by collection and resumes from its cursor', async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const send = (params: {
        readonly status: number;
        readonly body: unknown;
      }) => {
        response.writeHead(params.status, {
          'content-type': 'application/json',
        });
        response.end(jsonBody(params.body));
      };

      if (url.pathname.endsWith('describeRepo')) {
        send({
          status: 200,
          body: {
            did: DID,
            collections: ['app.bsky.feed.like', 'app.bsky.feed.post'],
          },
        });
        return;
      }

      const collection = url.searchParams.get('collection') ?? '';
      const cursor = url.searchParams.get('cursor');
      if (collection === 'app.bsky.feed.like' && cursor === null) {
        send({
          status: 200,
          body: {
            records: [
              envelope({
                collection,
                rkey: 'like-1',
                value: { subject: TARGET },
              }),
            ],
            cursor: 'like-second',
          },
        });
        return;
      }
      if (collection === 'app.bsky.feed.like') {
        send({
          status: 200,
          body: {
            records: [
              envelope({
                collection,
                rkey: 'like-2',
                value: { subject: TARGET },
              }),
            ],
          },
        });
        return;
      }
      send({
        status: 200,
        body: {
          records: [
            envelope({ collection, rkey: 'post-1', value: { text: 'hi' } }),
          ],
        },
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
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const close = Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
      catch: (cause) =>
        new Error(`closing the stub PDS failed: ${String(cause)}`),
    }).pipe(Effect.ignore);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const source = pdsBackfillSource({ baseUrl });
        const first = yield* source.pageOf({ did: DID, limit: 1 });
        const second = yield* source.pageOf({
          did: DID,
          cursor: first.cursor,
        });
        const third = yield* source.pageOf({
          did: DID,
          cursor: second.cursor,
        });
        return { first, second, third };
      }).pipe(Effect.ensuring(close)),
    );

    expect(result.first.records.map((record) => record.rkey)).toEqual([
      'like-1',
    ]);
    expect(result.first.records[0]?.collection).toBe('app.bsky.feed.like');
    expect(result.first.records[0]?.record).toEqual({ subject: TARGET });
    expect(result.first.cursor).toBeDefined();

    expect(result.second.records.map((record) => record.rkey)).toEqual([
      'like-2',
    ]);
    expect(result.second.records[0]?.collection).toBe('app.bsky.feed.like');
    expect(result.second.cursor).toBeDefined();

    expect(result.third.records.map((record) => record.rkey)).toEqual([
      'post-1',
    ]);
    expect(result.third.records[0]?.collection).toBe('app.bsky.feed.post');
    expect(result.third.cursor).toBeUndefined();
  });
});
