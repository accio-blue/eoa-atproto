import { type AuthRequestStore, memoryAuthRequests } from './auth-requests.js';
import {
  ClientError,
  type ClientMetadataSource,
  httpClientMetadata,
} from './clients.js';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { type GrantStore, memoryGrants } from './grants.js';
import { HttpRouter, HttpServer } from 'effect/http';
import { type PrivateKey, generateES256KeyPair } from '@eoa/crypto';
import { type TokenKeysShape, generateTokenKeys } from './keys.js';
import { createProof, dpopKeyThumbprint } from '@eoa/oauth';
import { describe, expect, it } from 'vitest';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';
import { providerLayer } from './provider.js';
import { providerRoutes } from './routes.js';
import { verifyAccessToken } from './tokens.js';

/**
 * The provider's front half over a real socket: the routes served by node, the client
 * being `fetch`, and the DPoP proofs made by the core's own `createProof`. Nothing
 * here is a mock of the protocol — the server verifies what it is sent.
 */

const CLIENT_ID = 'https://app.example/client-metadata.json';
const REDIRECT_URI = 'https://app.example/oauth-callback.html';
const CLIENT_SCOPE = 'atproto repo:com.example.thing';
const USER_DID = 'did:plc:alice';
const CSRF = 'a-csrf-token';
/** The RFC 7636 Appendix B pair, so the PKCE in the flow is real. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

/** A client registry that knows exactly one client. */
const stubClients = (): ClientMetadataSource => ({
  get: (clientId) =>
    clientId === CLIENT_ID
      ? Effect.succeed({
          clientId,
          redirectUris: [REDIRECT_URI],
          scope: CLIENT_SCOPE,
        })
      : Effect.fail(
          new ClientError({ message: `${clientId} is not a client of ours` }),
        ),
});

interface Served {
  readonly origin: string;
  readonly clientKey: PrivateKey;
  readonly keys: TokenKeysShape;
  readonly authRequests: AuthRequestStore;
  readonly grants: GrantStore;
  /** What the deployment says about the visitor; a test may change it. */
  readonly session: {
    did: string | undefined;
    scopes: readonly string[] | undefined;
    credential: string;
    credentialLive: boolean;
  };
}

/** Serve the provider on an ephemeral port, and run `body` against it. */
const withProvider = <A, E>(
  body: (served: Served) => Effect.Effect<A, E>,
  clients: ClientMetadataSource = stubClients(),
) =>
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
    const authRequests = memoryAuthRequests();
    const grants = memoryGrants();
    const session: {
      did: string | undefined;
      scopes: readonly string[] | undefined;
      credential: string;
      credentialLive: boolean;
    } = {
      did: USER_DID,
      scopes: undefined,
      credential: 'phone',
      credentialLive: true,
    };

    yield* Effect.forkScoped(
      Layer.launch(
        HttpRouter.serve(providerRoutes).pipe(
          Layer.provide(
            providerLayer({
              issuer: origin,
              audience: origin,
              keys,
              clients,
              authRequests,
              grants,
              sessions: {
                current: () =>
                  Effect.sync(() =>
                    session.did === undefined
                      ? undefined
                      : {
                          did: session.did,
                          scopes: session.scopes,
                          csrfToken: CSRF,
                          credential: session.credential,
                        },
                  ),
              },
              credentials: {
                live: () => Effect.sync(() => session.credentialLive),
              },
              signInPath: '/auth/sign-in',
            }),
          ),
        ),
      ),
    );
    yield* Effect.sleep('50 millis');

    return yield* body({
      origin,
      clientKey: clientKeyPair.privateKey,
      keys,
      authRequests,
      grants,
      session,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      NodeHttpServer.layer(createServer, { port: 0, host: '127.0.0.1' }),
    ),
  );

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

/** One signed form post, with an explicit nonce (or none): a single attempt. */
const postWithProof = (params: {
  readonly origin: string;
  readonly key: PrivateKey;
  readonly path: string;
  readonly form: Record<string, string>;
  readonly nonce?: string | undefined;
  readonly jti?: string | undefined;
  readonly proofFor?: string | undefined;
}) =>
  Effect.gen(function* () {
    const url = `${params.origin}${params.path}`;
    const proof = yield* createProof({
      key: params.key,
      htm: 'POST',
      htu: params.proofFor ?? url,
      ...(params.jti === undefined ? {} : { jti: params.jti }),
      ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
    });
    const response = yield* Effect.promise(() =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: proof,
        },
        body: new URLSearchParams(params.form).toString(),
      }),
    );
    const body: unknown = yield* Effect.promise(() => response.json());
    return {
      status: response.status,
      body,
      nonce: response.headers.get('DPoP-Nonce'),
    };
  });

/** Whether a refusal is the server asking for a DPoP nonce. */
const isChallenge = (body: unknown): boolean => {
  const decoded = Schema.decodeUnknownOption(ErrorBody)(body);
  return Option.isSome(decoded) && decoded.value.error === 'use_dpop_nonce';
};

/**
 * A signed form post the way the client makes one: send it, and if the server
 * answers `use_dpop_nonce`, send it once more with the nonce it just issued.
 */
const signedPost = (params: {
  readonly origin: string;
  readonly key: PrivateKey;
  readonly path: string;
  readonly form: Record<string, string>;
  readonly proofFor?: string | undefined;
  readonly jti?: string | undefined;
}) =>
  Effect.gen(function* () {
    const first = yield* postWithProof(params);
    if (!isChallenge(first.body) || first.nonce === null) {
      return first;
    }
    return yield* postWithProof({ ...params, nonce: first.nonce });
  });

/** Push an authorization request as the client does, retrying for a nonce. */
const pushAuthorizationRequest = (params: {
  readonly origin: string;
  readonly key: PrivateKey;
  readonly form: Record<string, string>;
  readonly proofFor?: string | undefined;
}) =>
  signedPost({
    origin: params.origin,
    key: params.key,
    path: '/oauth/par',
    form: params.form,
    ...(params.proofFor === undefined ? {} : { proofFor: params.proofFor }),
  });

/** A plain form post, with no proof: for the cases where that is the point. */
const postWithoutProof = (params: {
  readonly url: string;
  readonly form: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(params.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params.form).toString(),
      }),
    );
    const body: unknown = yield* Effect.promise(() => response.json());
    return { status: response.status, body };
  });

const parForm = (overrides: Record<string, string> = {}) => ({
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: CLIENT_SCOPE,
  state: 'a-state',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  login_hint: 'alice.test',
  ...overrides,
});

const ErrorBody = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
});

const errorOf = (body: unknown): string =>
  Schema.decodeUnknownSync(ErrorBody)(body).error;

const MetadataBody = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  pushed_authorization_request_endpoint: Schema.String,
  jwks_uri: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
  dpop_signing_alg_values_supported: Schema.Array(Schema.String),
  require_pushed_authorization_requests: Schema.Boolean,
});

const getJson = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetch(url));
    const body: unknown = yield* Effect.promise(() => response.json());
    return { status: response.status, body };
  });

/**
 * Walk the authorization page the way a browser does: fetch the page, then post the
 * decision. `redirect: 'manual'` because the 302 *is* the result we are after.
 */
const authorize = (params: {
  readonly origin: string;
  readonly requestUri: string;
  readonly decision?: string;
}) =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() =>
      fetch(
        `${params.origin}/oauth/authorize?request_uri=${encodeURIComponent(params.requestUri)}`,
        // a page request may redirect too - a refusal answers that way
        { redirect: 'manual' },
      ),
    );
    const html = yield* Effect.promise(() => page.text());
    const decided = yield* Effect.promise(() =>
      fetch(`${params.origin}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: params.requestUri,
          decision: params.decision ?? 'approve',
          csrf: CSRF,
        }).toString(),
        redirect: 'manual',
      }),
    );
    return {
      pageStatus: page.status,
      pageLocation: page.headers.get('location'),
      html,
      decisionStatus: decided.status,
      location: decided.headers.get('location'),
    };
  });

/** The parameters the client's redirect URI would receive. */
const callbackOf = (location: string | null): URLSearchParams | undefined =>
  location === null ? undefined : new URL(location).searchParams;

const ParResponse = Schema.Struct({
  request_uri: Schema.String,
  expires_in: Schema.Finite,
});

describe('the provider routes', () => {
  it('describes itself, and requires pushed requests', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const response = yield* getJson(
            `${served.origin}/.well-known/oauth-authorization-server`,
          );
          const metadata = yield* Schema.decodeUnknownEffect(MetadataBody)(
            response.body,
          );
          return { origin: served.origin, metadata };
        }),
      ),
    );

    const metadata = result.metadata;
    expect(metadata.issuer).toBe(result.origin);
    expect(metadata.pushed_authorization_request_endpoint).toBe(
      `${result.origin}/oauth/par`,
    );
    expect(metadata.authorization_endpoint).toBe(
      `${result.origin}/oauth/authorize`,
    );
    expect(metadata.token_endpoint).toBe(`${result.origin}/oauth/token`);
    expect(metadata.jwks_uri).toBe(`${result.origin}/oauth/jwks`);
    expect(metadata.require_pushed_authorization_requests).toBe(true);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.dpop_signing_alg_values_supported).toEqual(['ES256']);
  });

  it('publishes the key its tokens are signed with', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const response = yield* getJson(`${served.origin}/oauth/jwks`);
          return { response, shot: served.keys.kid };
        }),
      ),
    );

    const Jwks = Schema.Struct({
      keys: Schema.Array(
        Schema.Struct({
          kid: Schema.String,
          alg: Schema.String,
          use: Schema.String,
          kty: Schema.String,
          crv: Schema.String,
        }),
      ),
    });
    const jwks = Schema.decodeUnknownSync(Jwks)(result.response.body);

    expect(result.response.status).toBe(200);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.kid).toBe(result.shot);
    expect(jwks.keys[0]!.alg).toBe('ES256');
    expect(jwks.keys[0]!.use).toBe('sig');
  });

  it('accepts a pushed request and stores what the client committed to', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const pushed = yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm(),
          });
          const jkt = yield* dpopKeyThumbprint(served.clientKey);
          const par = yield* Schema.decodeUnknownEffect(ParResponse)(
            pushed.body,
          );
          return {
            pushed,
            par,
            jkt,
            stored: yield* served.authRequests.get({
              requestUri: par.request_uri,
              now: Math.floor(Date.now() / 1000),
            }),
          };
        }),
      ),
    );

    const par = result.par;

    expect(result.pushed.status).toBe(201);
    expect(par.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
    expect(par.expires_in).toBe(300);

    // what was pushed is what the browser's handle will stand for
    expect(result.stored?.clientId).toBe(CLIENT_ID);
    expect(result.stored?.redirectUri).toBe(REDIRECT_URI);
    expect(result.stored?.scope).toBe(CLIENT_SCOPE);
    expect(result.stored?.codeChallenge).toBe(parForm().code_challenge);
    expect(result.stored?.loginHint).toBe('alice.test');
    expect(result.jkt).toBeTruthy();
  });

  it('refuses a pushed request with no proof', async () => {
    const result = await run(
      withProvider((served) =>
        postWithoutProof({
          url: `${served.origin}/oauth/par`,
          form: parForm(),
        }),
      ),
    );

    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toBe('invalid_dpop_proof');
  });

  it('refuses a proof made for another URL', async () => {
    const result = await run(
      withProvider((served) =>
        pushAuthorizationRequest({
          origin: served.origin,
          key: served.clientKey,
          form: parForm(),
          proofFor: `${served.origin}/oauth/token`,
        }),
      ),
    );

    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toBe('invalid_dpop_proof');
  });

  it('refuses an unregistered redirect URI, and a request without PKCE', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const otherRedirect = yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm({ redirect_uri: 'https://evil.example/callback' }),
          });
          const noPkce = yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm({
              code_challenge: '',
              code_challenge_method: 'plain',
            }),
          });
          return { otherRedirect, noPkce };
        }),
      ),
    );

    expect(result.otherRedirect.status).toBe(400);
    expect(errorOf(result.otherRedirect.body)).toBe('invalid_request');
    expect(result.noPkce.status).toBe(400);
    expect(errorOf(result.noPkce.body)).toBe('invalid_request');
  });

  it('refuses a scope the client never declared', async () => {
    const result = await run(
      withProvider((served) =>
        pushAuthorizationRequest({
          origin: served.origin,
          key: served.clientKey,
          form: parForm({ scope: 'atproto transition:generic' }),
        }),
      ),
    );

    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toBe('invalid_scope');
  });

  it('refuses a request that commits to a key other than the one that signed it', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const other = yield* generateES256KeyPair();
          const otherJkt = yield* dpopKeyThumbprint(other.privateKey);
          return yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm({ dpop_jkt: otherJkt }),
          });
        }),
      ),
    );

    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toBe('invalid_dpop_proof');
  });

  it('refuses a client it does not know', async () => {
    const result = await run(
      withProvider((served) =>
        pushAuthorizationRequest({
          origin: served.origin,
          key: served.clientKey,
          form: parForm({
            client_id: 'https://stranger.example/metadata.json',
          }),
        }),
      ),
    );

    expect(result.status).toBe(401);
    expect(errorOf(result.body)).toBe('invalid_client');
  });
});

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  refresh_token: Schema.String,
  sub: Schema.String,
  scope: Schema.String,
  cnf: Schema.Struct({ jkt: Schema.String }),
});

const exchangeCode = (params: {
  readonly origin: string;
  readonly key: PrivateKey;
  readonly code: string;
  readonly verifier: string;
}) =>
  signedPost({
    origin: params.origin,
    key: params.key,
    path: '/oauth/token',
    form: {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: params.verifier,
    },
  });

/** Push and approve, stopping at the code the client would be handed. */
const approvedCode = (served: Served) =>
  Effect.gen(function* () {
    const jkt = yield* dpopKeyThumbprint(served.clientKey);
    const pushed = yield* pushAuthorizationRequest({
      origin: served.origin,
      key: served.clientKey,
      form: parForm({ dpop_jkt: jkt }),
    });
    const par = yield* Schema.decodeUnknownEffect(ParResponse)(pushed.body);
    const walked = yield* authorize({
      origin: served.origin,
      requestUri: par.request_uri,
    });
    return {
      jkt,
      walked,
      code: callbackOf(walked.location)?.get('code') ?? '',
    };
  });

/** Push, approve, exchange: everything up to a usable token. */
const approvedGrant = (served: Served) =>
  Effect.gen(function* () {
    const approved = yield* approvedCode(served);
    const exchanged = yield* exchangeCode({
      origin: served.origin,
      key: served.clientKey,
      code: approved.code,
      verifier: VERIFIER,
    });
    const tokens = yield* Schema.decodeUnknownEffect(TokenResponse)(
      exchanged.body,
    );
    return { ...approved, exchanged, tokens };
  });

describe('the provider authorization', () => {
  it('walks the whole flow: push, approve, exchange, and verifies what it issued', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const grant = yield* approvedGrant(served);
          const claims = yield* verifyAccessToken({
            keys: served.keys,
            token: grant.tokens.access_token,
            issuer: served.origin,
            audience: served.origin,
            now: Math.floor(Date.now() / 1000),
          });
          return { grant, claims };
        }),
      ),
    );

    const { grant, claims } = result;

    // the page asked, and the decision handed back a code for the client
    expect(grant.walked.pageStatus).toBe(200);
    expect(grant.walked.html).toContain(CLIENT_ID);
    expect(grant.walked.decisionStatus).toBe(302);
    const callback = callbackOf(grant.walked.location);
    expect(callback?.get('code')).toBeTruthy();
    expect(callback?.get('state')).toBe('a-state');
    expect(callback?.get('iss')).toBeTruthy();

    // the tokens are DPoP-bound, and the provider's own verifier accepts them
    expect(grant.tokens.token_type).toBe('DPoP');
    expect(grant.tokens.sub).toBe(USER_DID);
    expect(grant.tokens.cnf.jkt).toBe(grant.jkt);
    expect(claims.sub).toBe(USER_DID);
    expect(claims.scope).toBe(CLIENT_SCOPE);
    expect(claims.cnf.jkt).toBe(grant.jkt);
  });

  it('accepts a loopback client id and ignores the callback port', async () => {
    const callback = 'http://127.0.0.1:49832/callback';
    const requested = 'http://127.0.0.1:55555/callback';
    const clientId = `http://localhost?${new URLSearchParams({
      redirect_uri: callback,
      scope: CLIENT_SCOPE,
    }).toString()}`;

    const result = await run(
      withProvider(
        (served) =>
          Effect.gen(function* () {
            const pushed = yield* pushAuthorizationRequest({
              origin: served.origin,
              key: served.clientKey,
              form: parForm({
                client_id: clientId,
                redirect_uri: requested,
              }),
            });
            const par = yield* Schema.decodeUnknownEffect(ParResponse)(
              pushed.body,
            );
            const walked = yield* authorize({
              origin: served.origin,
              requestUri: par.request_uri,
            });
            return { pushed, walked };
          }),
        // localhost is not reachable from the server, and must not be fetched
        httpClientMetadata(() =>
          Promise.reject(new Error('a loopback id is never fetched')),
        ),
      ),
    );

    expect(result.pushed.status).toBe(201);
    expect(result.walked.decisionStatus).toBe(302);
    // the code goes to the port the app is listening on, not the one it declared
    const back = callbackOf(result.walked.location);
    expect(back?.get('code')).toBeTruthy();
    expect(result.walked.location?.startsWith(requested)).toBe(true);
  });

  it('rotates the refresh token, and spends the one that was presented', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const grant = yield* approvedGrant(served);
          const before = grant.tokens.refresh_token;
          const refreshed = yield* signedPost({
            origin: served.origin,
            key: served.clientKey,
            path: '/oauth/token',
            form: {
              grant_type: 'refresh_token',
              refresh_token: grant.tokens.refresh_token,
              client_id: CLIENT_ID,
            },
          });
          const rotated = yield* Schema.decodeUnknownEffect(TokenResponse)(
            refreshed.body,
          );
          // and the token we just spent is not usable again
          const replay = yield* signedPost({
            origin: served.origin,
            key: served.clientKey,
            path: '/oauth/token',
            form: {
              grant_type: 'refresh_token',
              refresh_token: grant.tokens.refresh_token,
              client_id: CLIENT_ID,
            },
          });
          return { before, refreshed, rotated, replay };
        }),
      ),
    );

    expect(result.refreshed.status).toBe(200);
    expect(result.rotated.refresh_token).not.toBe(result.before);
    expect(result.replay.status).toBe(400);
    expect(errorOf(result.replay.body)).toBe('invalid_grant');
  });

  it('refuses a refresh once the credential behind the grant is gone', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const grant = yield* approvedGrant(served);
          // the credential is revoked after the grant was made, and its refresh
          // token would otherwise be good for weeks
          served.session.credentialLive = false;
          const refused = yield* signedPost({
            origin: served.origin,
            key: served.clientKey,
            path: '/oauth/token',
            form: {
              grant_type: 'refresh_token',
              refresh_token: grant.tokens.refresh_token,
              client_id: CLIENT_ID,
            },
          });
          // the grant is spent, not merely refused this once
          const again = yield* signedPost({
            origin: served.origin,
            key: served.clientKey,
            path: '/oauth/token',
            form: {
              grant_type: 'refresh_token',
              refresh_token: grant.tokens.refresh_token,
              client_id: CLIENT_ID,
            },
          });
          return { refused, again };
        }),
      ),
    );

    expect(result.refused.status).toBe(400);
    expect(errorOf(result.refused.body)).toBe('invalid_grant');
    expect(result.again.status).toBe(400);
  });

  it('spends an authorization code on its first exchange', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const grant = yield* approvedGrant(served);
          const code = callbackOf(grant.walked.location)?.get('code') ?? '';
          const again = yield* exchangeCode({
            origin: served.origin,
            key: served.clientKey,
            code,
            verifier: VERIFIER,
          });
          return again;
        }),
      ),
    );

    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toBe('invalid_grant');
  });

  it('refuses a verifier that does not match the challenge', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const grant = yield* approvedGrant(served);
          const code = callbackOf(grant.walked.location)?.get('code') ?? '';
          return yield* exchangeCode({
            origin: served.origin,
            key: served.clientKey,
            code,
            verifier: 'not-the-verifier-that-was-committed-to',
          });
        }),
      ),
    );

    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toBe('invalid_grant');
  });

  it('refuses an exchange from a key the grant is not bound to', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          // a fresh code: the binding is checked before the code is spent
          const approved = yield* approvedCode(served);
          const mallory = yield* generateES256KeyPair();
          return yield* exchangeCode({
            origin: served.origin,
            key: mallory.privateKey,
            code: approved.code,
            verifier: VERIFIER,
          });
        }),
      ),
    );

    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toBe('invalid_dpop_proof');
  });

  it('ends the grant on revocation, and says so only by succeeding', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const grant = yield* approvedGrant(served);
          const revoked = yield* signedPost({
            origin: served.origin,
            key: served.clientKey,
            path: '/oauth/revoke',
            form: { token: grant.tokens.refresh_token, client_id: CLIENT_ID },
          });
          const after = yield* signedPost({
            origin: served.origin,
            key: served.clientKey,
            path: '/oauth/token',
            form: {
              grant_type: 'refresh_token',
              refresh_token: grant.tokens.refresh_token,
              client_id: CLIENT_ID,
            },
          });
          // and revoking something unknown is still a success, per RFC 7009
          const unknown = yield* signedPost({
            origin: served.origin,
            key: served.clientKey,
            path: '/oauth/revoke',
            form: { token: 'never-issued', client_id: CLIENT_ID },
          });
          return { revoked, after, unknown };
        }),
      ),
    );

    expect(result.revoked.status).toBe(200);
    expect(result.after.status).toBe(400);
    expect(errorOf(result.after.body)).toBe('invalid_grant');
    expect(result.unknown.status).toBe(200);
  });

  it('records a denial as a refusal, not as a grant', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const pushed = yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm(),
          });
          const par = yield* Schema.decodeUnknownEffect(ParResponse)(
            pushed.body,
          );
          return yield* authorize({
            origin: served.origin,
            requestUri: par.request_uri,
            decision: 'deny',
          });
        }),
      ),
    );

    const callback = callbackOf(result.location);
    expect(result.decisionStatus).toBe(302);
    expect(callback?.get('error')).toBe('access_denied');
    expect(callback?.get('code')).toBeNull();
    expect(callback?.get('state')).toBe('a-state');
  });

  it('asks a signed-out visitor to sign in, and refuses their decision', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const pushed = yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm(),
          });
          const par = yield* Schema.decodeUnknownEffect(ParResponse)(
            pushed.body,
          );
          served.session.did = undefined;
          return yield* authorize({
            origin: served.origin,
            requestUri: par.request_uri,
          });
        }),
      ),
    );

    expect(result.pageStatus).toBe(200);
    expect(result.html).toContain('Sign in first');
    // and it is not a dead end: the deployment's sign-in is one link away
    expect(result.html).toContain('/auth/sign-in?request_uri=');
    expect(result.decisionStatus).toBe(401);
  });

  it('refuses an authorization request it does not know', async () => {
    const result = await run(
      withProvider((served) =>
        authorize({
          origin: served.origin,
          requestUri: 'urn:ietf:params:oauth:request_uri:never-issued',
        }),
      ),
    );

    expect(result.pageStatus).toBe(400);
    expect(result.html).toContain('unknown');
  });
});

describe('what the session permits', () => {
  it('refuses a decision that does not present the session token', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const pushed = yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm(),
          });
          const par = yield* Schema.decodeUnknownEffect(ParResponse)(
            pushed.body,
          );
          // the decision, posted without the token the page carried
          const responded = yield* Effect.promise(() =>
            fetch(`${served.origin}/oauth/authorize`, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                request_uri: par.request_uri,
                decision: 'approve',
                csrf: 'not-the-token',
              }).toString(),
              redirect: 'manual',
            }),
          );
          return {
            status: responded.status,
            location: responded.headers.get('location'),
          };
        }),
      ),
    );

    // a state-changing decision from a stale form is refused, not merely logged
    expect(result.status).toBe(403);
    expect(result.location).toBeNull();
  });

  it('grants only what the credential behind the session permits', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          // a session whose credential allows the base scope but not the rest
          served.session.scopes = ['atproto'];
          const grant = yield* approvedGrant(served);
          return { grant, requested: CLIENT_SCOPE };
        }),
      ),
    );

    // the request asked for more; the page showed, and the token carries, the narrower
    expect(result.requested).toContain('repo:com.example.thing');
    expect(result.grant.walked.html).not.toContain('repo:com.example.thing');
    expect(result.grant.tokens.scope).toBe('atproto');
  });

  it('refuses outright when the credential permits none of what is asked', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          served.session.scopes = ['repo:elsewhere.example'];
          const pushed = yield* pushAuthorizationRequest({
            origin: served.origin,
            key: served.clientKey,
            form: parForm(),
          });
          const par = yield* Schema.decodeUnknownEffect(ParResponse)(
            pushed.body,
          );
          // asking to look at the page is already enough to know it cannot be granted
          return yield* authorize({
            origin: served.origin,
            requestUri: par.request_uri,
          });
        }),
      ),
    );

    expect(result.pageStatus).toBe(302);
    const callback = callbackOf(result.pageLocation);
    expect(callback?.get('error')).toBe('invalid_scope');
    expect(callback?.get('code')).toBeNull();
  });
});

/**
 * The challenge the client's retry depends on: a valid proof with no nonce is
 * refused with `use_dpop_nonce` and a fresh nonce in the same response, and the
 * only proof that gets in is one carrying that nonce. Replays of either half are
 * refused, which is the `dpop-nonce` machine doing its job.
 */
describe('the provider DPoP nonce challenge', () => {
  /** One PAR attempt, with an explicit nonce/jti when a test needs them. */
  const parAttempt = (params: {
    readonly served: Served;
    readonly nonce?: string | undefined;
    readonly jti?: string | undefined;
  }) =>
    postWithProof({
      origin: params.served.origin,
      key: params.served.clientKey,
      path: '/oauth/par',
      form: parForm(),
      ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
      ...(params.jti === undefined ? {} : { jti: params.jti }),
    });

  it('refuses a proof with no nonce, then accepts the retry that carries it', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const first = yield* parAttempt({ served });
          if (first.nonce === null) {
            return yield* Effect.die('the challenge carried no nonce');
          }
          const retried = yield* parAttempt({
            served,
            nonce: first.nonce,
          });
          return { first, retried };
        }),
      ),
    );

    // the exact pairing the client looks for: a 400 `use_dpop_nonce` and a
    // `DPoP-Nonce` header in the same response
    expect(result.first.status).toBe(400);
    expect(errorOf(result.first.body)).toBe('use_dpop_nonce');
    expect(result.first.nonce).toBeTruthy();
    // and the same request, now carrying that nonce, is served
    expect(result.retried.status).toBe(201);
  });

  it('refuses a nonce it has already consumed', async () => {
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const first = yield* parAttempt({ served });
          if (first.nonce === null) {
            return yield* Effect.die('the challenge carried no nonce');
          }
          const accepted = yield* parAttempt({ served, nonce: first.nonce });
          const replay = yield* parAttempt({ served, nonce: first.nonce });
          return { accepted, replay };
        }),
      ),
    );

    expect(result.accepted.status).toBe(201);
    expect(result.replay.status).toBe(400);
    expect(errorOf(result.replay.body)).toBe('use_dpop_nonce');
  });

  it('refuses a jti it has already accepted, even with the current nonce', async () => {
    const jti = 'a-proof-id-that-was-used-once';
    const result = await run(
      withProvider((served) =>
        Effect.gen(function* () {
          const first = yield* parAttempt({ served, jti });
          if (first.nonce === null) {
            return yield* Effect.die('the challenge carried no nonce');
          }
          const accepted = yield* parAttempt({
            served,
            nonce: first.nonce,
            jti,
          });
          if (accepted.nonce === null) {
            return yield* Effect.die('the acceptance carried no nonce');
          }
          const replay = yield* parAttempt({
            served,
            nonce: accepted.nonce,
            jti,
          });
          return { accepted, replay };
        }),
      ),
    );

    expect(result.accepted.status).toBe(201);
    expect(result.replay.status).toBe(400);
    expect(errorOf(result.replay.body)).toBe('invalid_dpop_proof');
  });
});
