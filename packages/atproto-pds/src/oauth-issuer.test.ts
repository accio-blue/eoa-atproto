import { AccountStore, accountStoreLayer } from './account-store.js';
import { BlobStore, blobStoreLayer } from './blob-store.js';
import { DpopReplay, dpopReplayLayer } from './dpop-replay.js';
import { Effect, Layer, Option, Schema } from 'effect';
import { Firehose, firehoseLayer } from './firehose.js';
import { Kv, kvMemoryLayer } from '@eoa/kv';
import {
  type PrivateKey,
  exportPrivateKey,
  exportPublicKey,
  generateES256KeyPair,
} from '@eoa/crypto';
import { RepoStore, repoStoreLayer } from '@eoa/repo-store';
import { SpaceStore, spaceStoreLayer } from './space-store.js';
import { challengeFor, createProof } from '@eoa/oauth';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@eoa/oauth';
import type { PdsConfig } from './pds.js';
import { createPdsOAuth } from './oauth-issuer.js';
import { createPdsServer } from './server.js';

/**
 * The PDS as its own authorization server, end to end.
 *
 * The protocol is `@eoa/oauth-provider`'s and is proven by its own tests. What
 * this test is about is the half the provider deliberately does not own: that a
 * browser session becomes an approval, that the approval becomes a token, and
 * that **this PDS accepts the token it issued** — the loop closing is the whole
 * point of the work, and nothing but a real call can show it.
 */

const DOMAIN = 'pds.example';

const ISSUER = `https://${DOMAIN}`;

const HANDLE = `alice.${DOMAIN}`;

const PASSWORD = 'correct horse battery staple';

const CLIENT_ID = 'https://app.example/client-metadata.json';

const REDIRECT_URI = 'https://app.example/oauth-callback.html';

/** The RFC 7636 Appendix B pair, so the PKCE in the flow is real. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

/** The client's metadata, served to the PDS by a fetch that is a map of one. */
const clients: FetchLike = async (request) => {
  if (request.url !== CLIENT_ID) {
    return new Response('no such client', { status: 404 });
  }
  return new Response(
    JSON.stringify({
      client_id: CLIENT_ID,
      redirect_uris: [REDIRECT_URI],
      scope: 'atproto',
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};

const SessionSchema = Schema.Struct({
  accessJwt: Schema.String,
  refreshJwt: Schema.String,
  handle: Schema.String,
  did: Schema.String,
});

const TokenSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.String,
  scope: Schema.String,
  sub: Schema.String,
});

const ParSchema = Schema.Struct({
  request_uri: Schema.String,
  expires_in: Schema.Number,
});

const jsonOf = <A>(schema: Schema.Codec<A>) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(schema));

interface Wiring {
  readonly handle: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
  readonly pds: (request: Request) => Promise<Response>;
  readonly clientKey: PrivateKey;
  readonly did: string;
}

/** The PDS and its issuer, over one in-memory store, with one account in it. */
const withPds = async <A>(body: (wiring: Wiring) => Promise<A>): Promise<A> => {
  const stack = Layer.mergeAll(
    repoStoreLayer,
    accountStoreLayer,
    blobStoreLayer,
    dpopReplayLayer,
    firehoseLayer(),
    spaceStoreLayer,
  ).pipe(Layer.provideMerge(kvMemoryLayer));
  const services = await Effect.runPromise(
    Effect.all({
      repo: RepoStore,
      accounts: AccountStore,
      blobs: BlobStore,
      replay: DpopReplay,
      firehose: Firehose,
      spaces: SpaceStore,
      kv: Kv,
    }).pipe(Effect.provide(stack)),
  );
  const signing = await Effect.runPromise(generateES256KeyPair());
  const issuerKeys = await Effect.runPromise(generateES256KeyPair());
  const publicJwk = await Effect.runPromise(
    exportPublicKey(issuerKeys.publicKey),
  );
  const privateJwk = await Effect.runPromise(
    exportPrivateKey(issuerKeys.privateKey),
  );
  const clientKeys = await Effect.runPromise(generateES256KeyPair());

  const config: PdsConfig = {
    did: `did:web:${DOMAIN}`,
    domain: DOMAIN,
    signingKey: signing.privateKey,
    clockId: 0,
    oauth: {
      issuer: ISSUER,
      jwk: {
        kty: String(publicJwk.kty),
        crv: String(publicJwk.crv),
        x: String(publicJwk.x),
        y: String(publicJwk.y),
      },
      privateJwk,
    },
  };
  const server = createPdsServer({
    config,
    repo: services.repo,
    accounts: services.accounts,
    blobs: services.blobs,
    replay: services.replay,
    firehose: services.firehose,
    mail: { send: () => Effect.void },
    spaces: services.spaces,
  });

  const oauth = await Effect.runPromise(
    createPdsOAuth({
      config,
      accounts: services.accounts,
      kv: services.kv,
      fetch: clients,
    }),
  );
  if (oauth === undefined) {
    throw new Error('the PDS did not become an issuer');
  }

  const created = await server.handle(
    new Request(`${ISSUER}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: HANDLE,
        email: 'alice@example.com',
        password: PASSWORD,
      }),
    }),
  );
  const session = jsonOf(SessionSchema)(await created.text());
  if (created.status !== 200 || Option.isNone(session)) {
    throw new Error(`the account was not created: ${created.status}`);
  }

  try {
    return await body({
      handle: oauth.handler,
      dispose: oauth.dispose,
      pds: (request) => server.handle(request),
      clientKey: clientKeys.privateKey,
      did: session.value.did,
    });
  } finally {
    await oauth.dispose();
  }
};

/** A DPoP step: the first attempt teaches the nonce, the second is the one that counts. */
const dpopStep = async (params: {
  readonly wiring: Wiring;
  readonly path: string;
  readonly form: Record<string, string>;
  readonly accessToken?: string;
}): Promise<{
  readonly response: Response;
  readonly nonce: string | undefined;
}> => {
  let nonce: string | undefined;
  let last: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proof = await Effect.runPromise(
      createProof({
        key: params.wiring.clientKey,
        htm: 'POST',
        htu: `${ISSUER}${params.path}`,
        ...(params.accessToken === undefined
          ? {}
          : { accessToken: params.accessToken }),
        ...(nonce === undefined ? {} : { nonce }),
      }),
    );
    const response = await params.wiring.handle(
      new Request(`${ISSUER}${params.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: proof,
        },
        body: new URLSearchParams(params.form).toString(),
      }),
    );
    nonce = response.headers.get('dpop-nonce') ?? nonce;
    last = response;
    if (response.status !== 400) {
      return { response, nonce };
    }
  }
  if (last === undefined) {
    throw new Error(`${params.path} was never answered`);
  }
  return { response: last, nonce };
};

const parse = async <A>(
  response: Response,
  schema: Schema.Codec<A>,
  what: string,
): Promise<A> => {
  const text = await response.text();
  const decoded = jsonOf(schema)(text);
  if (Option.isNone(decoded)) {
    throw new Error(`${what}: unexpected body ${text}`);
  }
  return decoded.value;
};

/** The whole flow, in the order a client and a browser do it. */
const authorize = async (wiring: Wiring) => {
  const challenge = await Effect.runPromise(challengeFor(VERIFIER));
  const pushed = await dpopStep({
    wiring,
    path: '/oauth/par',
    form: {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'atproto',
      state: 'round-trip',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
  });
  const par = await parse(pushed.response, ParSchema, 'par');

  // The browser is not signed in yet, so the consent page sends it here.
  const signIn = await wiring.handle(
    new Request(`${ISSUER}/oauth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        identifier: HANDLE,
        password: PASSWORD,
        request_uri: par.request_uri,
      }).toString(),
    }),
  );
  const cookie = signIn.headers.get('set-cookie')?.split(';')[0];
  if (signIn.status !== 303 || cookie === undefined) {
    throw new Error(`the sign-in did not set a session: ${signIn.status}`);
  }

  const consent = await wiring.handle(
    new Request(
      `${ISSUER}/oauth/authorize?request_uri=${encodeURIComponent(par.request_uri)}`,
      { headers: { cookie } },
    ),
  );
  const html = await consent.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (consent.status !== 200 || csrf === undefined) {
    throw new Error(`the consent page carried no csrf: ${consent.status}`);
  }

  const decision = await wiring.handle(
    new Request(`${ISSUER}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams({
        request_uri: par.request_uri,
        decision: 'approve',
        csrf,
      }).toString(),
    }),
  );
  const location = decision.headers.get('location') ?? '';
  const query = new URL(location).searchParams;
  const code = query.get('code');
  if (![302, 303].includes(decision.status) || code === null) {
    throw new Error(
      `the decision did not approve: ${decision.status} ${location}`,
    );
  }
  expect(query.get('state')).toBe('round-trip');

  const token = await dpopStep({
    wiring,
    path: '/oauth/token',
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: VERIFIER,
    },
  });
  return {
    tokens: await parse(token.response, TokenSchema, 'token'),
    nonce: token.nonce,
  };
};

describe('the PDS as an authorization server', () => {
  it('issues a token the PDS itself accepts, and refreshes it', async () => {
    await withPds(async (wiring) => {
      const { tokens } = await authorize(wiring);
      expect(tokens.token_type).toBe('DPoP');
      expect(tokens.scope.split(' ')).toContain('atproto');
      expect(tokens.sub).toBe(wiring.did);

      // The loop: the resource server checks a token this PDS signed.
      const proof = await Effect.runPromise(
        createProof({
          key: wiring.clientKey,
          htm: 'GET',
          htu: `${ISSUER}/xrpc/com.atproto.repo.listRecords`,
          accessToken: tokens.access_token,
        }),
      );
      const call = await wiring.pds(
        new Request(
          `${ISSUER}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(wiring.did)}&collection=app.bsky.feed.post`,
          {
            headers: {
              authorization: `DPoP ${tokens.access_token}`,
              dpop: proof,
            },
          },
        ),
      );
      expect(call.status).toBe(200);

      // A refresh mints a new pair, and the old refresh token is spent.
      const refreshed = await dpopStep({
        wiring,
        path: '/oauth/token',
        form: {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: CLIENT_ID,
        },
      });
      const next = await parse(refreshed.response, TokenSchema, 'refresh');
      expect(next.access_token).not.toBe(tokens.access_token);

      const spent = await dpopStep({
        wiring,
        path: '/oauth/token',
        form: {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: CLIENT_ID,
        },
      });
      expect(spent.response.status).toBe(400);
    });
  });

  it('sends a signed-out browser to sign in, and refuses a wrong password', async () => {
    await withPds(async (wiring) => {
      const pushed = await dpopStep({
        wiring,
        path: '/oauth/par',
        form: {
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          scope: 'atproto',
          state: 'x',
          code_challenge: await Effect.runPromise(challengeFor(VERIFIER)),
          code_challenge_method: 'S256',
        },
      });
      const par = await parse(pushed.response, ParSchema, 'par');

      const anonymous = await wiring.handle(
        new Request(
          `${ISSUER}/oauth/authorize?request_uri=${encodeURIComponent(par.request_uri)}`,
        ),
      );
      expect(await anonymous.text()).toContain('Sign in first');

      const refused = await wiring.handle(
        new Request(`${ISSUER}/oauth/sign-in`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            identifier: HANDLE,
            password: 'not the password',
            request_uri: par.request_uri,
          }).toString(),
        }),
      );
      expect(refused.status).toBe(401);
      expect(refused.headers.get('set-cookie')).toBeNull();
    });
  });

  it('is not an issuer when the deployment holds no signing key', async () => {
    const stack = Layer.mergeAll(
      repoStoreLayer,
      accountStoreLayer,
      blobStoreLayer,
      dpopReplayLayer,
      firehoseLayer(),
    ).pipe(Layer.provideMerge(kvMemoryLayer));
    const services = await Effect.runPromise(
      Effect.all({
        repo: RepoStore,
        accounts: AccountStore,
        blobs: BlobStore,
        replay: DpopReplay,
        firehose: Firehose,
        kv: Kv,
      }).pipe(Effect.provide(stack)),
    );
    const signing = await Effect.runPromise(generateES256KeyPair());
    const issuerKeys = await Effect.runPromise(generateES256KeyPair());
    const publicJwk = await Effect.runPromise(
      exportPublicKey(issuerKeys.publicKey),
    );
    const oauth = await Effect.runPromise(
      createPdsOAuth({
        config: {
          did: `did:web:${DOMAIN}`,
          domain: DOMAIN,
          signingKey: signing.privateKey,
          clockId: 0,
          oauth: {
            issuer: ISSUER,
            jwk: {
              kty: String(publicJwk.kty),
              crv: String(publicJwk.crv),
              x: String(publicJwk.x),
              y: String(publicJwk.y),
            },
          },
        },
        accounts: services.accounts,
        kv: services.kv,
        fetch: clients,
      }),
    );
    expect(oauth).toBeUndefined();
  });
});
