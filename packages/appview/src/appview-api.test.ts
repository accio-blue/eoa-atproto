import { AppviewApi, appviewApiHandlers } from './appview-api.js';
import { Effect, Fiber, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { IndexStore, indexStoreLayer } from './index-store.js';
import { describe, expect, it } from 'vitest';
import { HttpApiBuilder } from 'effect/http-api';
import { NodeHttpServer } from '@effect/platform-node';
import { backlinkLookupLayer } from './lookup.js';
import { createServer } from 'node:http';

/**
 * The backlinks surface over a real socket: the store is seeded, the API is
 * served on an ephemeral port, and the answer comes back through `fetch`, so
 * the routing, query decoding and gate wiring are all exercised together.
 */

const TARGET = 'at://did:plc:alice/app.bsky.feed.post/3k';
const SOURCE_A = 'at://did:plc:bob/app.bsky.feed.post/1';
const SOURCE_B = 'at://did:plc:carol/app.bsky.feed.post/2';

const BacklinksResult = Schema.Struct({
  decision: Schema.Literals(['visible', 'hidden', 'none']),
  sources: Schema.Array(Schema.String),
});

/**
 * The routes over the injected lookup. The handler layer's own requirements
 * are marker-wrapped until `HttpRouter.serve` unwraps them, so the lookup and
 * store are provided to the launched server rather than into `Routes`.
 */
const Routes = HttpApiBuilder.layer(AppviewApi).pipe(
  Layer.provide(appviewApiHandlers),
);

/** The lookup over one store, keeping both so the test can seed that store. */
const App = Layer.mergeAll(
  NodeHttpServer.layer(createServer, { port: 0 }),
  backlinkLookupLayer.pipe(Layer.provideMerge(indexStoreLayer)),
);

/** Serve the seeded AppView for the length of `body`, then tear it down. */
const withServedApp = <A>(body: (baseUrl: string) => Promise<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* IndexStore;
      yield* store.offer({ target: TARGET, source: SOURCE_A });
      yield* store.offer({ target: TARGET, source: SOURCE_B });

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

const lookup = async (params: {
  readonly baseUrl: string;
  readonly query: Record<string, string>;
}) => {
  const search = new URLSearchParams({ target: TARGET, ...params.query });
  const response = await fetch(
    `${params.baseUrl}/xrpc/app.effects.backlinks?${search}`,
  );

  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(BacklinksResult)(await response.json());
};

const bothSources = [SOURCE_A, SOURCE_B].sort();

describe('the backlinks XRPC surface', () => {
  it('returns a public subject with its sources', async () => {
    const result = await withServedApp((baseUrl) =>
      lookup({ baseUrl, query: { visibility: 'public' } }),
    );

    expect(result.decision).toBe('visible');
    expect([...result.sources].sort()).toEqual(bothSources);
  });

  it('returns a private subject for an active matching grant', async () => {
    const result = await withServedApp((baseUrl) =>
      lookup({
        baseUrl,
        query: {
          visibility: 'private',
          grant: 'active',
          subjectMatchesViewer: 'true',
          selectorOk: 'true',
          expired: 'false',
        },
      }),
    );

    expect(result.decision).toBe('visible');
    expect([...result.sources].sort()).toEqual(bothSources);
  });

  it('hides a private subject with a revoked grant', async () => {
    const result = await withServedApp((baseUrl) =>
      lookup({ baseUrl, query: { visibility: 'private', grant: 'revoked' } }),
    );

    expect(result).toEqual({ decision: 'hidden', sources: [] });
  });

  it('answers none for a subject with no visibility', async () => {
    const result = await withServedApp((baseUrl) =>
      lookup({ baseUrl, query: {} }),
    );

    expect(result).toEqual({ decision: 'none', sources: [] });
  });
});
