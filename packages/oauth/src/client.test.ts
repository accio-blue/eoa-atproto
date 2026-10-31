import { Effect, Schema } from 'effect';
import {
  type OAuthClient,
  OAuthClientError,
  makeOAuthClient,
  memoryPending,
} from './client.js';
import { type PrivateKey, generateES256KeyPair } from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { dpopKeyThumbprint, verifyProof } from './dpop.js';
import { splitJwt, valueFrom } from './jwt.js';
import { type FetchLike } from './http.js';
import { challengeFor } from './pkce.js';
import { memorySessionStore } from './session.js';

/**
 * The client, driven against a small authorization server that actually verifies
 * the DPoP proofs it is sent. A stub that answered 200 to everything would prove
 * the plumbing and nothing about the protocol; this one checks signatures, `htm`,
 * `htu`, `ath`, the PKCE verifier and the nonce, so the test fails the moment the
 * client stops binding its requests.
 *
 * Response bodies are written as literals rather than through `JSON.stringify`,
 * because this repo lints the global JSON API out of its own code.
 */

const AS = 'https://auth.example';
const PDS = 'https://pds.example';
const CLIENT_ID = 'https://app.example/client-metadata.json';
const REDIRECT_URI = 'https://app.example/oauth-callback.html';
const SCOPE = 'atproto transition:generic';
const DID = 'did:plc:alice';
const NONCE = 'a-server-nonce';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

interface JsonParams {
  readonly body: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
}

const json = (params: JsonParams) =>
  new Response(params.body, {
    status: params.status,
    headers: { 'Content-Type': 'application/json', ...params.headers },
  });

interface StubOptions {
  readonly tokenType?: string;
  readonly cnfJkt?: 'ours' | 'theirs' | 'none';
  readonly nonceForPar?: boolean;
  readonly nonceForResource?: boolean;
}

interface StubState {
  parAttempts: number;
  parParams: URLSearchParams | undefined;
  tokenAttempts: number;
  tokenParams: URLSearchParams | undefined;
  resourceAttempts: number;
  revoked: boolean;
  challenge: string | undefined;
  verifierMatched: boolean;
  accessToken: string;
  refreshToken: string;
}

interface ProofOutcome {
  readonly ok: boolean;
  readonly jkt: string;
  readonly message: string;
}

/**
 * The nonce a proof actually carries. A server that has handed one out must
 * insist on seeing it, or the retry proves nothing.
 */
const nonceFrom = async (proof: string): Promise<string | undefined> => {
  const { body } = await run(splitJwt(proof));
  const outcome = await run(
    Effect.result(
      valueFrom({
        schema: Schema.Struct({ nonce: Schema.optionalKey(Schema.String) }),
        segment: body,
        message: 'the payload is not a DPoP claim',
      }),
    ),
  );
  return outcome._tag === 'Success' ? outcome.success.nonce : undefined;
};

const makeStub = (options: StubOptions = {}) => {
  const state: StubState = {
    parAttempts: 0,
    parParams: undefined,
    tokenAttempts: 0,
    tokenParams: undefined,
    resourceAttempts: 0,
    revoked: false,
    challenge: undefined,
    verifierMatched: false,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
  };

  const proofOutcome = async (params: {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly accessToken?: string;
  }): Promise<ProofOutcome> => {
    const proof = params.headers.get('DPoP');
    if (proof === null) {
      return { ok: false, jkt: '', message: 'no DPoP proof was sent' };
    }
    const result = await run(
      Effect.result(
        verifyProof({
          proof,
          htm: params.method,
          htu: params.url,
          now: nowSeconds(),
          ...(params.accessToken === undefined
            ? {}
            : { accessToken: params.accessToken }),
        }),
      ),
    );
    return result._tag === 'Success'
      ? { ok: true, jkt: result.success.jkt, message: '' }
      : { ok: false, jkt: '', message: result.failure.message };
  };

  /** The nonce shape an authorization server uses: 400 with an error body. */
  const nonceRequired = () =>
    json({
      body: `{"error":"use_dpop_nonce","error_description":"nonce required"}`,
      status: 400,
      headers: { 'DPoP-Nonce': NONCE },
    });

  /** The nonce shape a resource server uses: 401 with a challenge. */
  const nonceChallenge = () =>
    new Response('', {
      status: 401,
      headers: {
        'WWW-Authenticate': `DPoP error="use_dpop_nonce"`,
        'DPoP-Nonce': NONCE,
      },
    });

  interface RequestParts {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly form: URLSearchParams;
  }

  const handlePar = async (request: RequestParts) => {
    state.parAttempts += 1;
    const proofHeader = request.headers.get('DPoP');
    if (
      options.nonceForPar === true &&
      (proofHeader === null || (await nonceFrom(proofHeader)) !== NONCE)
    ) {
      return nonceRequired();
    }
    const proof = await proofOutcome(request);
    if (!proof.ok) {
      return json({ body: `{"error":"invalid_dpop_proof"}`, status: 400 });
    }
    state.parParams = request.form;
    state.challenge = request.form.get('code_challenge') ?? undefined;
    return json({
      body: `{"request_uri":"urn:ietf:params:oauth:request_uri:stub","expires_in":60}`,
      status: 201,
    });
  };

  /** What the server says the token is bound to. */
  const boundJkt = (proofJkt: string): string | undefined => {
    if (options.cnfJkt === 'theirs') {
      return 'not-our-key';
    }
    if (options.cnfJkt === 'none') {
      return undefined;
    }
    return proofJkt;
  };

  const handleToken = async (request: RequestParts) => {
    state.tokenAttempts += 1;
    const proof = await proofOutcome(request);
    if (!proof.ok) {
      return json({ body: `{"error":"invalid_dpop_proof"}`, status: 400 });
    }
    state.tokenParams = request.form;

    const grant = request.form.get('grant_type');
    if (grant === 'authorization_code') {
      const verifier = request.form.get('code_verifier') ?? '';
      const derived = await run(challengeFor(verifier));
      state.verifierMatched = derived === (state.challenge ?? '');
      if (!state.verifierMatched) {
        return json({ body: `{"error":"invalid_grant"}`, status: 400 });
      }
    } else if (grant === 'refresh_token') {
      const presented = request.form.get('refresh_token');
      if (presented === null || !presented.startsWith('refresh')) {
        return json({ body: `{"error":"invalid_grant"}`, status: 400 });
      }
      // rotation: the next pair is new
      state.accessToken = 'access-2';
      state.refreshToken = 'refresh-2';
    }

    const jkt = boundJkt(proof.jkt);
    return json({
      body:
        `{"access_token":"${state.accessToken}",` +
        `"token_type":"${options.tokenType ?? 'DPoP'}",` +
        `"sub":"${DID}",` +
        `"scope":"${SCOPE}",` +
        `"refresh_token":"${state.refreshToken}",` +
        `"expires_in":3600` +
        (jkt === undefined ? '' : `,"cnf":{"jkt":"${jkt}"}`) +
        `}`,
      status: 200,
    });
  };

  const handleResource = async (request: RequestParts) => {
    state.resourceAttempts += 1;
    const proofHeader = request.headers.get('DPoP');
    if (
      options.nonceForResource === true &&
      (proofHeader === null || (await nonceFrom(proofHeader)) !== NONCE)
    ) {
      return nonceChallenge();
    }

    const authorization = request.headers.get('Authorization');
    const accessToken = authorization?.startsWith('DPoP ')
      ? authorization.slice(5)
      : undefined;
    const proof = await proofOutcome({
      ...request,
      ...(accessToken === undefined ? {} : { accessToken }),
    });
    if (!proof.ok) {
      return json({ body: `{"error":"invalid_dpop_proof"}`, status: 401 });
    }
    return json({ body: `{"ok":true}`, status: 200 });
  };

  const fetch: FetchLike = async ({ url, init }) => {
    const parsed = new URL(url);
    const request: RequestParts = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      form: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
    };

    if (parsed.pathname === '/.well-known/oauth-protected-resource') {
      return json({
        body: `{"resource":"${PDS}","authorization_servers":["${AS}"]}`,
        status: 200,
      });
    }
    if (parsed.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        body:
          `{"issuer":"${AS}",` +
          `"authorization_endpoint":"${AS}/oauth/authorize",` +
          `"token_endpoint":"${AS}/oauth/token",` +
          `"pushed_authorization_request_endpoint":"${AS}/oauth/par",` +
          `"revocation_endpoint":"${AS}/oauth/revoke"}`,
        status: 200,
      });
    }
    if (parsed.pathname === '/oauth/par') {
      return handlePar(request);
    }
    if (parsed.pathname === '/oauth/token') {
      return handleToken(request);
    }
    if (parsed.pathname === '/oauth/revoke') {
      state.revoked = true;
      return json({ body: '{}', status: 200 });
    }
    return handleResource(request);
  };

  return { fetch, state };
};

const makeKey = async (): Promise<{ privateKey: PrivateKey; jkt: string }> => {
  const keyPair = await run(generateES256KeyPair());
  const jkt = await run(dpopKeyThumbprint(keyPair.privateKey));
  return { privateKey: keyPair.privateKey, jkt };
};

interface TestClient {
  readonly privateKey: PrivateKey;
  readonly jkt: string;
  readonly client: OAuthClient;
}

const makeClient = async (
  stub: ReturnType<typeof makeStub>,
): Promise<TestClient> => {
  const key = await makeKey();
  const client = makeOAuthClient({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    key: key.privateKey,
    fetch: stub.fetch,
    sessions: memorySessionStore(),
  });
  return { client, ...key };
};

const logIn = async (client: OAuthClient) => {
  const started = await run(
    client.createAuthorizationUrl({ pdsUrl: PDS, identifier: 'alice.test' }),
  );
  const session = await run(
    client.finalizeAuthorization({
      params: new URLSearchParams({
        code: 'the-code',
        state: started.state,
        iss: AS,
      }),
    }),
  );
  return { started, session };
};

describe('the OAuth client', () => {
  it('logs in through PAR, and binds the request to its key', async () => {
    const stub = makeStub();
    const { client, jkt } = await makeClient(stub);

    const { started, session } = await logIn(client);

    const url = new URL(started.url);
    expect(url.origin).toBe(AS);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('request_uri')).toBe(
      'urn:ietf:params:oauth:request_uri:stub',
    );

    // the pushed request committed to a challenge, and to our key
    const par = stub.state.parParams;
    expect(par?.get('code_challenge_method')).toBe('S256');
    expect(par?.get('dpop_jkt')).toBe(jkt);
    expect(par?.get('login_hint')).toBe('alice.test');
    expect(par?.get('code_challenge')).toBeTruthy();

    // the exchange presented the verifier for that challenge
    expect(stub.state.verifierMatched).toBe(true);
    expect(stub.state.tokenParams?.get('grant_type')).toBe(
      'authorization_code',
    );

    expect(session.did).toBe(DID);
    expect(session.accessToken).toBe('access-1');
    expect(session.refreshToken).toBe('refresh-1');
    expect(session.dpopJkt).toBe(jkt);
    // the session must remember the resource server its token is for
    expect(session.pdsUrl).toBe(PDS);
    expect(session.expiresAt).toBeGreaterThan(nowSeconds());
  });

  it('comes back to the callback a loopback login bound for itself', async () => {
    const stub = makeStub();
    const { client } = await makeClient(stub);
    const loopback = 'http://127.0.0.1:49152/callback';

    const started = await run(
      client.createAuthorizationUrl({
        pdsUrl: PDS,
        identifier: 'alice.test',
        redirectUri: loopback,
      }),
    );
    await run(
      client.finalizeAuthorization({
        params: new URLSearchParams({
          code: 'the-code',
          state: started.state,
          iss: AS,
        }),
      }),
    );

    // both legs must name the same callback, or the server refuses the exchange
    expect(stub.state.parParams?.get('redirect_uri')).toBe(loopback);
    expect(stub.state.tokenParams?.get('redirect_uri')).toBe(loopback);
  });

  it('retries once with the nonce the server asks for', async () => {
    const stub = makeStub({ nonceForPar: true });
    const { client } = await makeClient(stub);

    const { session } = await logIn(client);

    // the first push was refused for a nonce; the second carried it
    expect(stub.state.parAttempts).toBe(2);
    expect(session.accessToken).toBe('access-1');
  });

  it('sends a proof bound to the token on an ordinary request', async () => {
    const stub = makeStub();
    const { client } = await makeClient(stub);
    const { session } = await logIn(client);

    const response = await run(
      client.signedFetch({
        did: session.did,
        url: `${PDS}/xrpc/com.atproto.repo.listRecords`,
      }),
    );

    expect(response.status).toBe(200);
    expect(stub.state.resourceAttempts).toBe(1);
  });

  it('retries a resource request when the resource server asks for a nonce', async () => {
    const stub = makeStub({ nonceForResource: true });
    const { client } = await makeClient(stub);
    const { session } = await logIn(client);

    const response = await run(
      client.signedFetch({
        did: session.did,
        url: `${PDS}/xrpc/com.atproto.repo.listRecords`,
      }),
    );

    expect(response.status).toBe(200);
    expect(stub.state.resourceAttempts).toBe(2);
  });

  it('rotates the refresh token and stores the new one', async () => {
    const stub = makeStub();
    const { client } = await makeClient(stub);
    const { session } = await logIn(client);

    const refreshed = await run(client.refreshSession({ session }));

    expect(refreshed.accessToken).toBe('access-2');
    expect(refreshed.refreshToken).toBe('refresh-2');
    expect(stub.state.tokenParams?.get('grant_type')).toBe('refresh_token');

    const stored = await run(client.getSession({ did: session.did }));
    expect(stored?.accessToken).toBe('access-2');
  });

  it('refuses a bearer token, or one bound to another key', async () => {
    const bearer = makeStub({ tokenType: 'Bearer' });
    const bearerClient = await makeClient(bearer);
    await expect(logIn(bearerClient.client)).rejects.toThrow(
      /not a DPoP-bound one/,
    );

    const otherKey = makeStub({ cnfJkt: 'theirs' });
    const otherClient = await makeClient(otherKey);
    await expect(logIn(otherClient.client)).rejects.toThrow(
      /bound to a different key/,
    );
  });

  it('refuses a callback it did not start, and a foreign issuer', async () => {
    const stub = makeStub();
    const { client } = await makeClient(stub);

    await expect(
      run(
        client.finalizeAuthorization({
          params: new URLSearchParams({ code: 'c', state: 'not-ours' }),
        }),
      ),
    ).rejects.toThrow(/does not match a login/);

    // a real login, but the issuer is not the one we started at
    const started = await run(
      client.createAuthorizationUrl({ pdsUrl: PDS, identifier: 'alice.test' }),
    );
    await expect(
      run(
        client.finalizeAuthorization({
          params: new URLSearchParams({
            code: 'c',
            state: started.state,
            iss: 'https://evil.example',
          }),
        }),
      ),
    ).rejects.toThrow(/but this login started at/);
  });

  it('reports a refusal by the user with the server own code', async () => {
    const stub = makeStub();
    const { client } = await makeClient(stub);

    const outcome = await run(
      Effect.result(
        client.finalizeAuthorization({
          params: new URLSearchParams({
            error: 'access_denied',
            error_description: 'the user said no',
          }),
        }),
      ),
    );

    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure') {
      expect(outcome.failure).toBeInstanceOf(OAuthClientError);
      expect(outcome.failure.code).toBe('access_denied');
      expect(outcome.failure.message).toContain('the user said no');
    }
  });

  it('refreshes an expiring session before the request goes out', async () => {
    const stub = makeStub();
    const key = await makeKey();
    // a clock we can move: the session's expiry is computed when it is issued, so
    // only real elapsed time can make it expiring
    let clock = nowSeconds();
    const client = makeOAuthClient({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      key: key.privateKey,
      fetch: stub.fetch,
      sessions: memorySessionStore(),
      now: () => clock,
    });

    const started = await run(
      client.createAuthorizationUrl({ pdsUrl: PDS, identifier: 'alice.test' }),
    );
    const session = await run(
      client.finalizeAuthorization({
        params: new URLSearchParams({
          code: 'the-code',
          state: started.state,
          iss: AS,
        }),
      }),
    );
    expect(session.accessToken).toBe('access-1');

    // an hour later the access token is well past its 3600 s
    clock += 3600;

    const response = await run(
      client.signedFetch({
        did: session.did,
        url: `${PDS}/xrpc/com.atproto.repo.listRecords`,
      }),
    );

    expect(response.status).toBe(200);
    // the request went out with a freshly refreshed token
    expect(stub.state.tokenParams?.get('grant_type')).toBe('refresh_token');
    expect(stub.state.accessToken).toBe('access-2');
  });

  it('revokes on the way out, then forgets the session', async () => {
    const stub = makeStub();
    const { client } = await makeClient(stub);
    const { session } = await logIn(client);

    await run(client.revokeSession({ session }));

    expect(stub.state.revoked).toBe(true);
    expect(await run(client.getSession({ did: session.did }))).toBeUndefined();
  });
  it('keeps the nonce the server rotated to, so the next request is not challenged', async () => {
    // a server that challenges and rotates, as the provider does
    const current = { value: 'nonce-1' };
    const issued = { count: 1 };
    const fetch: FetchLike = async ({ init }) => {
      const proof = new Headers(init.headers).get('dpop') ?? '';
      const presented = await nonceFrom(proof);
      if (presented !== current.value) {
        // a resource server's challenge shape: 401 with WWW-Authenticate, which is
        // what signedFetch is looking for (an authorization server says it with 400)
        return new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'DPoP error="use_dpop_nonce"',
            'DPoP-Nonce': current.value,
          },
        });
      }
      // accepted: the nonce is consumed and rotated, and the response carries the next
      issued.count += 1;
      current.value = `nonce-${issued.count}`;
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'DPoP-Nonce': current.value,
        },
      });
    };

    const stored: { value: string | undefined } = { value: undefined };
    const key = await makeKey();
    const client = makeOAuthClient({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      key: key.privateKey,
      fetch,
      sessions: {
        get: async () => ({
          did: DID,
          accessToken: 'an-access-token',
          scope: SCOPE,
          issuer: 'https://auth.example',
          pdsUrl: 'https://pds.example',
          tokenEndpoint: 'https://auth.example/oauth/token',
          dpopJkt: key.jkt,
        }),
        set: async () => {},
        delete: async () => {},
      },
      nonces: {
        get: async () => stored.value,
        set: async ({ nonce }) => {
          stored.value = nonce;
        },
      },
    });

    const response = await run(
      client.signedFetch({
        did: DID,
        url: 'https://pds.example/xrpc/com.atproto.repo.listRecords',
      }),
    );

    expect(response.status).toBe(200);
    // the challenge was answered, and what matters is that the *rotated* nonce was
    // kept: dropping it means every later request pays for a challenge it did not need
    expect(stored.value).toBe('nonce-2');
  });
});

/**
 * The browser's half of the shape: the consent page is a navigation, so the
 * process that finishes the login is not the one that started it. Everything the
 * second half needs has to have been handed to a store before the first half
 * returned — which is exactly what a page reload tests.
 */
describe('a login that a reload interrupts', () => {
  it('finishes in a process that did not start it', async () => {
    const stub = makeStub();
    const key = await makeKey();
    const sessions = memorySessionStore();
    const pending = memoryPending();

    const before = makeOAuthClient({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      key: key.privateKey,
      fetch: stub.fetch,
      sessions,
      pending,
    });
    const started = await run(
      before.createAuthorizationUrl({ pdsUrl: PDS, identifier: 'alice.test' }),
    );

    // A new page load: the same stores, a client with nothing in memory.
    const after = makeOAuthClient({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      key: key.privateKey,
      fetch: stub.fetch,
      sessions,
      pending,
    });
    const session = await run(
      after.finalizeAuthorization({
        params: new URLSearchParams({
          code: 'the-code',
          state: started.state,
          iss: AS,
        }),
      }),
    );

    expect(session.did).toBe(DID);
    expect(await run(after.getSession({ did: DID }))).toBeDefined();
  });
});
