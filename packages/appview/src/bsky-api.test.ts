import { BskyApi, bskyApiHandlers } from './bsky-api.js';
import { CanonicalStore, canonicalStoreLayer } from './canonical-store.js';
import { Effect, Fiber, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { describe, expect, it } from 'vitest';
import { HandleResolver } from './handle-resolver.js';
import { HttpApiBuilder } from 'effect/http-api';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';

/**
 * The hydrated AppView reads over a real socket: the canonical store is seeded
 * once, the handles are a fake resolver, and the answers come back through
 * `fetch`, so routing, query decoding and hydration are exercised together.
 */

const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const POST = 'app.bsky.feed.post';
const PROFILE = 'app.bsky.actor.profile';

const postUri = (did: string) => (rkey: string) =>
  `at://${did}/${POST}/${rkey}`;
const profileUri = (did: string) => `at://${did}/${PROFILE}/self`;

const CREATED_AT = '2026-01-02T03:04:05.000Z';

const post = (did: string) => (rkey: string) => (createdAt: string) => ({
  uri: postUri(did)(rkey),
  cid: `bafy-${rkey}`,
  value: { $type: POST, text: 'hello', createdAt },
});

const replyPost = (did: string) => (rkey: string) => ({
  uri: postUri(did)(rkey),
  cid: `bafy-${rkey}`,
  value: {
    $type: POST,
    text: 'a reply',
    createdAt: CREATED_AT,
    reply: {
      parent: { uri: postUri(did)('3k'), cid: 'bafy-3k' },
      root: { uri: postUri(did)('3k'), cid: 'bafy-3k' },
    },
  },
});

const mediaPost = (did: string) => (rkey: string) => ({
  uri: postUri(did)(rkey),
  cid: `bafy-${rkey}`,
  value: {
    $type: POST,
    text: 'with media',
    createdAt: CREATED_AT,
    embed: { $type: 'app.bsky.embed.images', images: [] },
  },
});

const profile = (did: string) => (displayName: string) => ({
  uri: profileUri(did),
  cid: `bafy-profile-${did}`,
  value: { displayName, description: 'Alice bio' },
});

/** A resolver that knows ALICE only; every other DID falls back to itself. */
const handleResolverLayer = Layer.succeed(HandleResolver, {
  handleOf: (did) => Effect.succeed(did === ALICE ? 'alice.test' : undefined),
  didOf: (handle) =>
    Effect.succeed(handle === 'alice.test' ? ALICE : undefined),
});

/**
 * The routes over the injected store and resolver. The handler layer's own
 * requirements are marker-wrapped until `HttpRouter.serve` unwraps them, so the
 * services are provided to the launched server rather than into `Routes`.
 */
const Routes = HttpApiBuilder.layer(BskyApi).pipe(
  Layer.provide(bskyApiHandlers),
);

const App = Layer.mergeAll(
  NodeHttpServer.layer(createServer, { port: 0 }),
  canonicalStoreLayer,
  handleResolverLayer,
);

/** Serve the seeded store for the length of `body`, then tear it down. */
const withServedApp = <A>(body: (baseUrl: string) => Promise<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CanonicalStore;
      yield* store.apply(post(ALICE)('3k')(CREATED_AT));
      yield* store.apply(replyPost(ALICE)('3a'));
      yield* store.apply(mediaPost(ALICE)('3b'));
      yield* store.apply(post(ALICE)('3c')(CREATED_AT));
      yield* store.apply(post(BOB)('3k')(CREATED_AT));
      yield* store.apply(profile(ALICE)('Alice'));

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

/** One author-feed page as raw JSON, with the actor defaulted to ALICE. */
const getAuthorFeed = async (params: {
  readonly baseUrl: string;
  readonly query: Record<string, string>;
}) => {
  const search = new URLSearchParams({ actor: ALICE, ...params.query });
  const response = await fetch(
    `${params.baseUrl}/xrpc/app.bsky.feed.getAuthorFeed?${search}`,
  );
  expect(response.status).toBe(200);
  return await response.json();
};

describe('the hydrated getPostThread read', () => {
  it('hydrates a stored post into the thread view the client decodes', async () => {
    const thread = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri(ALICE)('3k'))}`,
      );
      expect(response.status).toBe(200);
      return (await response.json()).thread;
    });

    expect(thread).toEqual({
      $type: 'app.bsky.feed.defs#threadViewPost',
      post: {
        uri: postUri(ALICE)('3k'),
        cid: 'bafy-3k',
        author: { did: ALICE, handle: 'alice.test', displayName: 'Alice' },
        record: { $type: POST, text: 'hello', createdAt: CREATED_AT },
        indexedAt: CREATED_AT,
      },
    });
  });

  it('answers an unknown URI with a 200 notFoundPost', async () => {
    const thread = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri(ALICE)('missing'))}`,
      );
      expect(response.status).toBe(200);
      return (await response.json()).thread;
    });

    expect(thread).toEqual({
      $type: 'app.bsky.feed.defs#notFoundPost',
      uri: postUri(ALICE)('missing'),
    });
  });

  it('falls back to the DID when the resolver knows no handle', async () => {
    const post = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri(BOB)('3k'))}`,
      );
      expect(response.status).toBe(200);
      return (await response.json()).thread.post;
    });

    // No displayName either: BOB has no stored profile, so the field is absent.
    expect(post.author).toEqual({ did: BOB, handle: BOB });
  });

  it('accepts depth and parentHeight', async () => {
    const status = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri(ALICE)('3k'))}&depth=6&parentHeight=20`,
      );
      return response.status;
    });

    expect(status).toBe(200);
  });
});

describe('the hydrated getProfile read', () => {
  it('answers a DID with the detailed profile and its post count', async () => {
    const profile = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(ALICE)}`,
      );
      expect(response.status).toBe(200);
      return await response.json();
    });

    // postsCount is ALICE's four posts, not BOB's one.
    expect(profile).toEqual({
      did: ALICE,
      handle: 'alice.test',
      displayName: 'Alice',
      description: 'Alice bio',
      postsCount: 4,
    });
  });

  it('resolves a handle through the directory', async () => {
    const profile = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.bsky.actor.getProfile?actor=alice.test`,
      );
      expect(response.status).toBe(200);
      return await response.json();
    });

    expect(profile).toEqual({
      did: ALICE,
      handle: 'alice.test',
      displayName: 'Alice',
      description: 'Alice bio',
      postsCount: 4,
    });
  });

  it('answers an unknown handle with a 404', async () => {
    const status = await withServedApp(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/xrpc/app.bsky.actor.getProfile?actor=unknown.test`,
      );
      return response.status;
    });

    expect(status).toBe(404);
  });
});

describe('the hydrated getAuthorFeed read', () => {
  const urisOf = (body: { feed: Array<{ post: { uri: string } }> }) =>
    body.feed.map((item) => item.post.uri);

  it('excludes reply posts from posts_no_replies', async () => {
    const uris = await withServedApp(async (baseUrl) => {
      const body = await getAuthorFeed({
        baseUrl,
        query: { filter: 'posts_no_replies', includePins: 'true' },
      });
      return urisOf(body);
    });

    // Newest first, and the reply at 3a is gone.
    expect(uris).toEqual([
      postUri(ALICE)('3k'),
      postUri(ALICE)('3c'),
      postUri(ALICE)('3b'),
    ]);
  });

  it('keeps only embedded posts from posts_with_media', async () => {
    const uris = await withServedApp(async (baseUrl) => {
      const body = await getAuthorFeed({
        baseUrl,
        query: { filter: 'posts_with_media' },
      });
      return urisOf(body);
    });

    expect(uris).toEqual([postUri(ALICE)('3b')]);
  });

  it('keeps every post of the actor from posts_with_replies', async () => {
    const uris = await withServedApp(async (baseUrl) => {
      const body = await getAuthorFeed({
        baseUrl,
        query: { filter: 'posts_with_replies' },
      });
      return urisOf(body);
    });

    expect(uris).toEqual([
      postUri(ALICE)('3k'),
      postUri(ALICE)('3c'),
      postUri(ALICE)('3b'),
      postUri(ALICE)('3a'),
    ]);
    expect(uris).not.toContain(postUri(BOB)('3k'));
  });

  it('pages with a cursor and ends without one', async () => {
    const pages = await withServedApp(async (baseUrl) => {
      const first = await getAuthorFeed({
        baseUrl,
        query: { filter: 'posts_with_replies', limit: '1' },
      });
      const second = await getAuthorFeed({
        baseUrl,
        query: {
          filter: 'posts_with_replies',
          limit: '1',
          cursor: first.cursor,
        },
      });
      const third = await getAuthorFeed({
        baseUrl,
        query: {
          filter: 'posts_with_replies',
          limit: '1',
          cursor: second.cursor,
        },
      });
      const fourth = await getAuthorFeed({
        baseUrl,
        query: {
          filter: 'posts_with_replies',
          limit: '1',
          cursor: third.cursor,
        },
      });
      return { first, second, third, fourth };
    });

    expect(pages.first.feed).toHaveLength(1);
    expect(pages.first.cursor).toBe('3k');
    expect(pages.fourth.feed).toHaveLength(1);
    expect(pages.fourth.cursor).toBeUndefined();
  });
});
