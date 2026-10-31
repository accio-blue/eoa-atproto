import { CanonicalApi, canonicalApiHandlers } from './canonical-api.js';
import { CanonicalStore, canonicalStoreLayer } from './canonical-store.js';
import { Effect, Fiber, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { describe, expect, it } from 'vitest';
import { HttpApiBuilder } from 'effect/http-api';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';

/**
 * The canonical read surface over a real socket: the store is seeded once, the
 * API is served on an ephemeral port, and the answers come back through
 * `fetch`, so routing, query decoding and paging are exercised together.
 */

const DID = 'did:plc:genesis';
const POST = 'app.bsky.feed.post';
const LIKE = 'app.bsky.feed.like';

const postUri = (rkey: string) => `at://${DID}/${POST}/${rkey}`;
const likeUri = (rkey: string) => `at://${DID}/${LIKE}/${rkey}`;

const post = (rkey: string) => ({
  uri: postUri(rkey),
  cid: `bafy-${rkey}`,
  value: { $type: POST, text: rkey },
});

const like = (rkey: string) => ({
  uri: likeUri(rkey),
  cid: `bafy-${rkey}`,
  value: { $type: LIKE, subject: { uri: postUri('a') } },
});

/**
 * The routes over the injected store. The handler layer's own requirements are
 * marker-wrapped until `HttpRouter.serve` unwraps them, so the store is
 * provided to the launched server rather than into `Routes`.
 */
const Routes = HttpApiBuilder.layer(CanonicalApi).pipe(
  Layer.provide(canonicalApiHandlers),
);

const App = Layer.mergeAll(
  NodeHttpServer.layer(createServer, { port: 0 }),
  canonicalStoreLayer,
);

/** Serve the seeded canonical store for the length of `body`, then tear it down. */
const withServedApp = <A>(body: (baseUrl: string) => Promise<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CanonicalStore;
      yield* store.apply(post('a'));
      yield* store.apply(post('b'));
      yield* store.apply(like('z'));

      const address = (yield* HttpServer.HttpServer).address;
      if (!('port' in address)) {
        return yield* Effect.die('the appview is not listening on a port');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const serving = yield* Effect.forkScoped(
        Layer.launch(HttpRouter.serve(Routes)),
      );
      yield* Effect.sleep('50 millis');

      const result = yield* Effect.promise(() => body(baseUrl));

      yield* Fiber.interrupt(serving);
      return result;
    }).pipe(Effect.provide(App), Effect.scoped),
  );

describe('the canonical read surface', () => {
  it('serves a record by URI as the envelope it holds', async () => {
    const envelope = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.effects.getRecord?uri=${encodeURIComponent(postUri('a'))}`,
      );
      expect(response.status).toBe(200);
      return await response.json();
    });

    expect(envelope).toEqual(post('a'));
  });

  it('answers an unknown URI with 404', async () => {
    const status = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.effects.getRecord?uri=${encodeURIComponent(postUri('missing'))}`,
      );
      return response.status;
    });

    expect(status).toBe(404);
  });

  it('pages a collection with limit=1, and the last page has no cursor', async () => {
    const pages = await withServedApp(async (baseUrl) => {
      const first = await fetch(
        `${baseUrl}/xrpc/app.effects.listRecords?collection=${POST}&limit=1`,
      );
      expect(first.status).toBe(200);
      const firstPage = await first.json();

      const second = await fetch(
        `${baseUrl}/xrpc/app.effects.listRecords?collection=${POST}&limit=1&cursor=${firstPage.cursor}`,
      );
      expect(second.status).toBe(200);

      return { firstPage, secondPage: await second.json() };
    });

    expect(pages.firstPage.records).toEqual([post('a')]);
    expect(pages.firstPage.cursor).toBe('a');
    expect(pages.secondPage.records).toEqual([post('b')]);
    expect(pages.secondPage.cursor).toBeUndefined();
  });

  it('does not mix two collections in one page', async () => {
    const page = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.effects.listRecords?collection=${LIKE}`,
      );
      expect(response.status).toBe(200);
      return await response.json();
    });

    expect(page.records).toEqual([like('z')]);
  });

  it('rejects a malformed limit with 400, not 500', async () => {
    const status = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.effects.listRecords?collection=${POST}&limit=not-a-number`,
      );
      return response.status;
    });

    expect(status).toBe(400);
  });
});
