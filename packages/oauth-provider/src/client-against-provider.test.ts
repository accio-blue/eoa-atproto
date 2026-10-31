import { Effect, Layer, Predicate, Result } from 'effect';
import {
  type FetchLike,
  dpopKeyThumbprint,
  makeOAuthClient,
  memorySessionStore,
} from '@eoa/oauth';
import { HttpRouter, HttpServer } from 'effect/http';
import { type PrivateKey, generateES256KeyPair } from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { ClientError } from './clients.js';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';
import { generateTokenKeys } from './keys.js';
import { memoryAuthRequests } from './auth-requests.js';
import { memoryGrants } from './grants.js';
import { providerLayer } from './provider.js';
import { providerRoutes } from './routes.js';

/**
 * The two roles, against each other.
 *
 * The provider's own tests drive it with hand-made requests, and the client's tests
 * drive it against a stub server. Both can pass while the two halves disagree —
 * about a parameter name, a response field, the wording of an error. This is the
 * check that cannot: the real client, unmodified, walks a real flow through the real
 * provider, over a socket.
 *
 * The only thing it does not cover is the human, who is a `fetch` here.
 */

const CLIENT_ID = 'https://app.example/client-metadata.json';
const REDIRECT_URI = 'https://app.example/oauth-callback.html';
const SCOPE = 'atproto repo:com.example.thing';
const USER_DID = 'did:plc:alice';
const CSRF = 'a-csrf-token';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The plugin's bridge: the client's port takes one object, the platform's takes two. */
const platformFetch: FetchLike = (request) => fetch(request.url, request.init);

interface Served {
  readonly origin: string;
  readonly clientKey: PrivateKey;
}

/** Serve the provider on an ephemeral port, and run `body` against it. */
const withProvider = <A, E>(body: (served: Served) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const address = (yield* HttpServer.HttpServer).address;
    const port = Predicate.hasProperty(address, 'port')
      ? address.port
      : undefined;
    if (port === undefined) {
      return yield* Effect.die('the test server is not listening on a port');
    }
    const origin = `http://127.0.0.1:${port}`;

    const keys = yield* generateTokenKeys;
    const clientKeyPair = yield* generateES256KeyPair();

    yield* Effect.forkScoped(
      Layer.launch(
        HttpRouter.serve(providerRoutes).pipe(
          Layer.provide(
            providerLayer({
              issuer: origin,
              audience: origin,
              keys,
              clients: {
                get: (clientId) =>
                  clientId === CLIENT_ID
                    ? Effect.succeed({
                        clientId,
                        redirectUris: [REDIRECT_URI],
                        scope: SCOPE,
                      })
                    : Effect.fail(
                        new ClientError({
                          message: `${clientId} is not a client of ours`,
                        }),
                      ),
              },
              authRequests: memoryAuthRequests(),
              grants: memoryGrants(),
              sessions: {
                current: () =>
                  Effect.succeed({
                    did: USER_DID,
                    scopes: undefined,
                    csrfToken: CSRF,
                    credential: 'phone',
                  }),
              },
              credentials: { live: () => Effect.succeed(true) },
            }),
          ),
        ),
      ),
    );
    yield* Effect.sleep('50 millis');

    return yield* body({ origin, clientKey: clientKeyPair.privateKey });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      NodeHttpServer.layer(createServer, { port: 0, host: '127.0.0.1' }),
    ),
  );

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

/** Approve the request the client just pushed, as the person would. */
const approve = (params: {
  readonly origin: string;
  readonly requestUri: string;
}) =>
  Effect.gen(function* () {
    const decided = yield* Effect.promise(() =>
      fetch(`${params.origin}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: params.requestUri,
          decision: 'approve',
          csrf: CSRF,
        }).toString(),
        redirect: 'manual',
      }),
    );
    return decided.headers.get('location');
  });

const makeClient = (params: {
  readonly origin: string;
  readonly key: PrivateKey;
}) =>
  makeOAuthClient({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    key: params.key,
    fetch: platformFetch,
    sessions: memorySessionStore(),
  });

describe('the client against the provider', () => {
  it('logs in: push, approve, exchange — with each half checking the other', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const client = makeClient({
            origin: served.origin,
            key: served.clientKey,
          });
          const jkt = yield* dpopKeyThumbprint(served.clientKey);

          // the client discovers the server itself: the provider serves no
          // protected-resource document, so this walks the fallback too
          const started = yield* client.createAuthorizationUrl({
            pdsUrl: served.origin,
            identifier: 'alice.test',
          });
          const requestUri = new URL(started.url).searchParams.get(
            'request_uri',
          );
          if (requestUri === null) {
            return yield* Effect.die('the client did not push a request');
          }

          const location = yield* approve({
            origin: served.origin,
            requestUri,
          });
          if (location === null) {
            return yield* Effect.die('the approval did not redirect');
          }
          const callback = new URL(location).searchParams;
          const code = callback.get('code');
          if (code === null) {
            return yield* Effect.die('the approval carried no code');
          }

          // the client checks the state, the issuer, and the key its token is bound to
          const session = yield* client.finalizeAuthorization({
            params: new URLSearchParams({
              code,
              state: started.state,
              iss: callback.get('iss') ?? served.origin,
            }),
          });

          const refreshed = yield* client.refreshSession({ session });
          yield* client.revokeSession({ session: refreshed });
          const afterRevoke = yield* Effect.result(
            client.refreshSession({ session: refreshed }),
          );

          return {
            origin: served.origin,
            jkt,
            session,
            refreshed,
            afterRevoke,
          };
        }),
      ),
    );

    // the session the client built is the one the provider meant to issue
    expect(result.session.did).toBe(USER_DID);
    expect(result.session.dpopJkt).toBe(result.jkt);
    expect(result.session.pdsUrl).toBe(result.origin);
    expect(result.session.accessToken).toBeTruthy();
    expect(result.session.refreshToken).toBeTruthy();
    expect(result.session.expiresAt).toBeGreaterThan(nowSeconds() - 5);

    // a refresh rotates, and revocation ends it
    expect(result.refreshed.refreshToken).not.toBe(result.session.refreshToken);
    expect(Result.isFailure(result.afterRevoke)).toBe(true);
  });

  it('refuses a callback the client did not start', async () => {
    const outcome = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const client = makeClient({
            origin: served.origin,
            key: served.clientKey,
          });
          return yield* Effect.result(
            client.finalizeAuthorization({
              params: new URLSearchParams({
                code: 'made-up',
                state: 'not-ours',
              }),
            }),
          );
        }),
      ),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure.message).toMatch(/does not match a login/);
    }
  });
});
