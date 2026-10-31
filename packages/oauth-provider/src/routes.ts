import { Effect, Layer, Result, Schema } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Provider, type ProviderShape } from './provider.js';
import { verifyChallenge, verifyProof } from '@eoa/oauth';
import { base64urlEncode } from '@eoa/crypto';
import { issueAccessToken } from './tokens.js';
import { redirectUriMatches } from './clients.js';

/**
 * The authorization server: what it says it is, its keys, and the four steps a
 * client goes through.
 *
 * `push` → `authorize` → `token` → (later) `revoke`. PAR matters more than it looks:
 * without it the authorization request — scope, redirect, PKCE challenge — travels
 * through the browser, where it lands in history, referrers and logs. With it the
 * browser carries one opaque handle and the parameters are exchanged directly.
 * That is why `require_pushed_authorization_requests` is `true` here rather than a
 * fallback.
 *
 * Two rules run through all of it, and a deployment weakens one by weakening both:
 * the client's DPoP key is bound at the push and held to at every later step, and an
 * authorization code is consumed by its first exchange.
 *
 * Deliberate rule: every DPoP-protected step (PAR, token, revoke) must present the
 * current DPoP *nonce*. A missing or stale one is refused with a 400
 * `use_dpop_nonce` and a fresh `DPoP-Nonce` in the same response, which is exactly
 * what the client's single retry looks for; acceptance consumes the nonce and
 * advances the replay state through the `dpop-nonce` model
 * (`packages/specs/specs/oauth/`), so neither the nonce nor the jti can be reused.
 */

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** An opaque handle: a code, a refresh token, or a request uri. */
const randomToken = (): string =>
  base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

/**
 * HTML escaping, because these pages interpolate things a client chose — its own
 * `client_id` and the scope it asked for. A consent screen that renders those
 * unescaped is an XSS hole a hostile client can aim at the user.
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** An OAuth error, in the shape the profile requires. */
const oauthError = (params: {
  readonly status: number;
  readonly error: string;
  readonly description: string;
}) =>
  HttpServerResponse.jsonUnsafe(
    { error: params.error, error_description: params.description },
    { status: params.status },
  );

/** A response carrying the nonce the client should present next. */
const withDpopNonce = (params: {
  readonly response: HttpServerResponse.HttpServerResponse;
  readonly nonce: string;
}): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeader(params.response, 'DPoP-Nonce', params.nonce);

/**
 * What a DPoP-protected endpoint needs from a verified proof, or the refusal to
 * answer with. The proof is verified first, so a cryptographically valid proof
 * with a missing or stale *nonce* is challenged rather than called invalid — the
 * client's single retry depends on that distinction.
 */
type DpopGuard =
  | { readonly ok: true; readonly jkt: string; readonly nonce: string }
  | {
      readonly ok: false;
      readonly response: HttpServerResponse.HttpServerResponse;
    };

const requireDpop = (params: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly provider: ProviderShape;
  readonly htm: string;
  readonly now: number;
}): Effect.Effect<DpopGuard, never> =>
  Effect.gen(function* () {
    const url = new URL(params.request.url, params.provider.issuer).toString();

    const proof = params.request.headers['dpop'];
    if (proof === undefined) {
      return {
        ok: false,
        response: oauthError({
          status: 400,
          error: 'invalid_dpop_proof',
          description: 'a DPoP proof is required',
        }),
      };
    }
    const verified = yield* Effect.result(
      verifyProof({ proof, htm: params.htm, htu: url, now: params.now }),
    );
    if (Result.isFailure(verified)) {
      return {
        ok: false,
        response: oauthError({
          status: 400,
          error: 'invalid_dpop_proof',
          description: verified.failure.message,
        }),
      };
    }

    const verdict = yield* Effect.result(
      params.provider.nonces.verify({
        origin: new URL(url).origin,
        nonce: verified.success.nonce,
        jti: verified.success.jti,
      }),
    );
    if (Result.isFailure(verdict)) {
      return {
        ok: false,
        response: oauthError({
          status: 500,
          error: 'server_error',
          description: 'the nonce could not be checked',
        }),
      };
    }

    if (verdict.success.rejection === 'jti') {
      return {
        ok: false,
        response: oauthError({
          status: 400,
          error: 'invalid_dpop_proof',
          description: 'the proof has already been used',
        }),
      };
    }
    if (verdict.success.rejection === 'nonce') {
      return {
        ok: false,
        response: withDpopNonce({
          response: oauthError({
            status: 400,
            error: 'use_dpop_nonce',
            description: 'a fresh DPoP nonce is required',
          }),
          nonce: verdict.success.nonce,
        }),
      };
    }

    return {
      ok: true,
      jkt: verified.success.jkt,
      nonce: verdict.success.nonce,
    };
  });

/** A page, rather than a JSON error: this one is read by a person. */
const errorPage = (params: {
  readonly status: number;
  readonly message: string;
}) =>
  // `text` rather than `html`, because the status is the point: a refusal must not
  // answer 200 and hope the reader notices the body
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization</title>` +
      `</head><body style="font-family: system-ui; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">` +
      `<h1>Authorization</h1><p>${escapeHtml(params.message)}</p></body></html>`,
    { contentType: 'text/html; charset=utf-8', status: params.status },
  );

/** The server's own description of itself. */
const metadata = (_request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const base = provider.issuer;

    return HttpServerResponse.jsonUnsafe({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      pushed_authorization_request_endpoint: `${base}/oauth/par`,
      revocation_endpoint: `${base}/oauth/revoke`,
      jwks_uri: `${base}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['none'],
      require_pushed_authorization_requests: true,
      request_uri_parameter_supported: true,
      authorization_response_iss_parameter_supported: true,
      // informational: the base scope, and a deployment narrows further by policy
      scopes_supported: ['atproto'],
    });
  });

/** The keys an access token is verified against. */
const jwks = (_request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    return HttpServerResponse.jsonUnsafe(provider.keys.jwks);
  });

const ParRequestSchema = Schema.Struct({
  client_id: Schema.String,
  response_type: Schema.String,
  redirect_uri: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  code_challenge: Schema.optionalKey(Schema.String),
  code_challenge_method: Schema.optionalKey(Schema.String),
  login_hint: Schema.optionalKey(Schema.String),
  dpop_jkt: Schema.optionalKey(Schema.String),
});

/**
 * Whether every permission the request asks for was declared by the client.
 *
 * ponytail: a plain subset check over the space-separated list. atproto's scopes can
 * *narrow* rather than only repeat (a `repo:collection` permission is within a
 * broader one), so this refuses some legitimate narrowings; widen it when a real
 * client asks for one.
 */
const withinDeclaredScope = (params: {
  readonly requested: string;
  readonly declared: string;
}): boolean => {
  const declared = new Set(
    params.declared.split(' ').filter((entry) => entry !== ''),
  );
  return params.requested
    .split(' ')
    .filter((entry) => entry !== '')
    .every((entry) => declared.has(entry));
};

/**
 * The permissions a credential allows, out of the ones a client asked for.
 *
 * `undefined` credential scopes mean the whole account, so nothing narrows. An empty
 * result is not a grant of nothing — it is a refusal, and the caller says so.
 */
const intersectScope = (params: {
  readonly requested: string;
  readonly credential: readonly string[] | undefined;
}): readonly string[] => {
  const requested = params.requested.split(' ').filter((entry) => entry !== '');
  if (params.credential === undefined) {
    return requested;
  }
  const allowed = new Set(params.credential);
  return requested.filter((entry) => allowed.has(entry));
};

/** The authorization response for a request that will not be granted. */
const refuseAuthorization = (params: {
  readonly request: {
    readonly redirectUri: string;
    readonly state: string | undefined;
  };
  readonly error: string;
}): HttpServerResponse.HttpServerResponse => {
  const back = new URL(params.request.redirectUri);
  back.searchParams.set('error', params.error);
  if (params.request.state !== undefined) {
    back.searchParams.set('state', params.request.state);
  }
  return HttpServerResponse.redirect(back);
};

/** Push an authorization request, and answer with the handle that stands for it. */
const pushedAuthorizationRequest = (
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const now = nowSeconds();

    const guard = yield* requireDpop({ request, provider, htm: 'POST', now });
    if (!guard.ok) {
      return guard.response;
    }

    const parsed = yield* Effect.result(
      HttpServerRequest.schemaBodyUrlParams(ParRequestSchema),
    );
    if (Result.isFailure(parsed)) {
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description: 'the body is not a pushed authorization request',
      });
    }
    const body = parsed.success;

    if (body.response_type !== 'code') {
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description: 'only response_type=code is supported',
      });
    }
    if (
      body.code_challenge === undefined ||
      body.code_challenge_method !== 'S256'
    ) {
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description: 'PKCE with code_challenge_method=S256 is required',
      });
    }
    // the client may commit to the key it will present, and we hold it to that
    if (body.dpop_jkt !== undefined && body.dpop_jkt !== guard.jkt) {
      return oauthError({
        status: 400,
        error: 'invalid_dpop_proof',
        description: 'dpop_jkt is not the key that signed this proof',
      });
    }

    const client = yield* Effect.result(provider.clients.get(body.client_id));
    if (Result.isFailure(client)) {
      return oauthError({
        status: 401,
        error: 'invalid_client',
        description: client.failure.message,
      });
    }
    if (
      !client.success.redirectUris.some((registered) =>
        redirectUriMatches(registered, body.redirect_uri),
      )
    ) {
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description: `${body.redirect_uri} is not a registered redirect URI for this client`,
      });
    }

    const scope = body.scope ?? 'atproto';
    const declared = client.success.scope;
    if (
      declared !== undefined &&
      !withinDeclaredScope({ requested: scope, declared })
    ) {
      return oauthError({
        status: 400,
        error: 'invalid_scope',
        description: `${scope} is not within the scope this client declares`,
      });
    }

    const requestUri = `urn:ietf:params:oauth:request_uri:${randomToken()}`;
    const stored = yield* Effect.result(
      provider.authRequests.put({
        requestUri,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        scope,
        state: body.state,
        codeChallenge: body.code_challenge,
        loginHint: body.login_hint,
        dpopJkt: body.dpop_jkt,
        expiresAt: now + provider.requestTtlSeconds,
      }),
    );
    if (Result.isFailure(stored)) {
      return oauthError({
        status: 500,
        error: 'server_error',
        description: 'the request could not be stored',
      });
    }

    return withDpopNonce({
      response: HttpServerResponse.jsonUnsafe(
        { request_uri: requestUri, expires_in: provider.requestTtlSeconds },
        { status: 201 },
      ),
      nonce: guard.nonce,
    });
  });

/**
 * The authorization page: who is asking, for what, and the two buttons.
 *
 * Rendering rather than auto-approving is the honest default — this is the only
 * point in the flow where a person decides anything, and a provider that grants
 * silently makes every push an authorization.
 *
 * Not signed in is a page too: the provider has no login of its own (that is the
 * deployment's, and the account's: see M4), so it says so rather than guessing.
 */
const authorizationPage = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const requestUri = new URL(request.url, provider.issuer).searchParams.get(
      'request_uri',
    );
    if (requestUri === null) {
      return errorPage({
        status: 400,
        message: 'This request carries no request_uri.',
      });
    }

    const pushed = yield* Effect.result(
      provider.authRequests.get({ requestUri, now: nowSeconds() }),
    );
    if (Result.isFailure(pushed) || pushed.success === undefined) {
      return errorPage({
        status: 400,
        message:
          'This authorization request is unknown, or has expired. Start again.',
      });
    }

    const session = yield* provider.sessions.current(request);
    if (session === undefined) {
      // the deployment's sign-in, carrying the request through so the visitor
      // comes back to the page they were on rather than starting over
      const signIn = provider.signInPath;
      const link =
        signIn === undefined
          ? ''
          : `<p><a href="${escapeHtml(signIn)}?request_uri=${encodeURIComponent(requestUri)}">Sign in</a></p>`;
      return HttpServerResponse.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title>` +
          `</head><body style="font-family: system-ui; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">` +
          `<h1>Sign in first</h1><p>You need to be signed in before an application can ask for access.</p>` +
          link +
          `</body></html>`,
      );
    }

    const requested = pushed.success;
    // what the credential behind this session actually permits of what was asked
    const granted = intersectScope({
      requested: requested.scope,
      credential: session.scopes,
    });
    if (granted.length === 0) {
      return refuseAuthorization({
        request: requested,
        error: 'invalid_scope',
      });
    }

    return HttpServerResponse.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorize</title>` +
        `</head><body style="font-family: system-ui; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">` +
        `<h1>Authorize this application?</h1>` +
        `<p><code>${escapeHtml(requested.clientId)}</code> is asking to act as ` +
        `<code>${escapeHtml(session.did)}</code>, for:</p>` +
        // the scope shown is the one that will be granted, not merely the one asked for
        `<pre style="white-space: pre-wrap">${escapeHtml(granted.join(' '))}</pre>` +
        `<form method="post" action="/oauth/authorize">` +
        `<input type="hidden" name="request_uri" value="${escapeHtml(requestUri)}">` +
        `<input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">` +
        `<button name="decision" value="approve" style="padding:.5rem 1rem">Approve</button> ` +
        `<button name="decision" value="deny" style="padding:.5rem 1rem">Deny</button>` +
        `</form></body></html>`,
    );
  });

/** The approval itself: mint the code and send the browser back to the client. */
const authorizationDecision = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const now = nowSeconds();

    const parsed = yield* Effect.result(
      HttpServerRequest.schemaBodyUrlParams(
        Schema.Struct({
          request_uri: Schema.String,
          decision: Schema.String,
          csrf: Schema.String,
        }),
      ),
    );
    if (Result.isFailure(parsed)) {
      return errorPage({ status: 400, message: 'This decision is malformed.' });
    }

    const pushed = yield* Effect.result(
      provider.authRequests.get({
        requestUri: parsed.success.request_uri,
        now,
      }),
    );
    if (Result.isFailure(pushed) || pushed.success === undefined) {
      return errorPage({
        status: 400,
        message:
          'This authorization request is unknown, or has expired. Start again.',
      });
    }
    const requested = pushed.success;

    const session = yield* provider.sessions.current(request);
    if (session === undefined) {
      return errorPage({ status: 401, message: 'You are not signed in.' });
    }
    if (parsed.success.csrf !== session.csrfToken) {
      // the page a person decided on was not the page this session is holding:
      // refused rather than merely logged, because the decision is state-changing
      return errorPage({
        status: 403,
        message: 'This form is stale. Start again from the application.',
      });
    }

    const back = new URL(requested.redirectUri);
    if (requested.state !== undefined) {
      back.searchParams.set('state', requested.state);
    }

    if (parsed.success.decision !== 'approve') {
      back.searchParams.set('error', 'access_denied');
      return HttpServerResponse.redirect(back);
    }

    // the granted scope is the credential's narrowing of what was asked for, so a
    // scoped app password yields a scoped token rather than a full-account one
    const granted = intersectScope({
      requested: requested.scope,
      credential: session.scopes,
    });
    if (granted.length === 0) {
      return refuseAuthorization({
        request: requested,
        error: 'invalid_scope',
      });
    }

    const code = randomToken();
    const minted = yield* Effect.result(
      provider.grants.putCode({
        code,
        clientId: requested.clientId,
        did: session.did,
        scope: granted.join(' '),
        redirectUri: requested.redirectUri,
        codeChallenge: requested.codeChallenge,
        dpopJkt: requested.dpopJkt,
        // carried onto the refresh token, so a later refresh can ask if it is live
        credential: session.credential,
        expiresAt: now + provider.codeTtlSeconds,
      }),
    );
    if (Result.isFailure(minted)) {
      return errorPage({
        status: 500,
        message: 'The code could not be issued.',
      });
    }
    // the pushed request is spent: one approval, one code
    yield* provider.authRequests.delete({ requestUri: requested.requestUri });

    back.searchParams.set('code', code);
    // RFC 9207: the client checks this is the server it started at
    back.searchParams.set('iss', provider.issuer);
    return HttpServerResponse.redirect(back);
  });

/** Issue the pair of tokens for an approved grant. */
const issueFor = (params: {
  readonly did: string;
  readonly scope: string;
  readonly jkt: string;
  readonly clientId: string;
  readonly credential: string;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const accessToken = yield* Effect.result(
      issueAccessToken({
        keys: provider.keys,
        issuer: provider.issuer,
        audience: provider.audience,
        did: params.did,
        scope: params.scope,
        credential: params.credential,
        jkt: params.jkt,
        now: params.now,
        ttlSeconds: provider.accessTokenTtlSeconds,
      }),
    );
    if (Result.isFailure(accessToken)) {
      return oauthError({
        status: 500,
        error: 'server_error',
        description: `the access token could not be issued: ${accessToken.failure.message}`,
      });
    }

    const refreshToken = `atr_${randomToken()}`;
    yield* provider.grants.putRefresh({
      token: refreshToken,
      clientId: params.clientId,
      did: params.did,
      scope: params.scope,
      dpopJkt: params.jkt,
      credential: params.credential,
      expiresAt: params.now + provider.refreshTtlSeconds,
    });

    return HttpServerResponse.jsonUnsafe({
      access_token: accessToken.success,
      token_type: 'DPoP',
      refresh_token: refreshToken,
      expires_in: provider.accessTokenTtlSeconds,
      scope: params.scope,
      sub: params.did,
      cnf: { jkt: params.jkt },
    });
  });

const TokenRequestSchema = Schema.Struct({
  grant_type: Schema.String,
  code: Schema.optionalKey(Schema.String),
  redirect_uri: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
  code_verifier: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
});

/** Spend an authorization code: PKCE, the client it was issued to, and the key it is bound to. */
const exchangeAuthorizationCode = (params: {
  readonly provider: ProviderShape;
  readonly body: Schema.Schema.Type<typeof TokenRequestSchema>;
  readonly jkt: string;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const { provider, body, jkt, now } = params;
    const code = body.code;
    const verifier = body.code_verifier;
    const clientId = body.client_id;
    if (
      code === undefined ||
      verifier === undefined ||
      clientId === undefined
    ) {
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description:
          'an authorization_code exchange needs code, code_verifier and client_id',
      });
    }

    // taking the code consumes it: a replay finds nothing
    const taken = yield* Effect.result(provider.grants.takeCode({ code, now }));
    if (Result.isFailure(taken) || taken.success === undefined) {
      return oauthError({
        status: 400,
        error: 'invalid_grant',
        description: 'the code is unknown, already used, or expired',
      });
    }
    const grant = taken.success;

    if (grant.clientId !== clientId) {
      return oauthError({
        status: 400,
        error: 'invalid_grant',
        description: 'the code was issued to another client',
      });
    }
    if (
      body.redirect_uri !== undefined &&
      body.redirect_uri !== grant.redirectUri
    ) {
      return oauthError({
        status: 400,
        error: 'invalid_grant',
        description: 'the redirect URI is not the one the code was issued for',
      });
    }

    const pkce = yield* Effect.result(
      verifyChallenge({ verifier, challenge: grant.codeChallenge }),
    );
    if (Result.isFailure(pkce) || !pkce.success) {
      return oauthError({
        status: 400,
        error: 'invalid_grant',
        description: 'the code verifier does not match the challenge',
      });
    }

    // the key committed at the push, or the one presenting the proof now
    if (grant.dpopJkt !== undefined && grant.dpopJkt !== jkt) {
      return oauthError({
        status: 400,
        error: 'invalid_dpop_proof',
        description: 'the proof is not from the key this code is bound to',
      });
    }

    return yield* issueFor({
      did: grant.did,
      scope: grant.scope,
      jkt: grant.dpopJkt ?? jkt,
      clientId: grant.clientId,
      credential: grant.credential,
      now,
    });
  });

/** Rotate a refresh token: the presented one is spent whether or not the rest succeeds. */
const refreshGrant = (params: {
  readonly provider: ProviderShape;
  readonly body: Schema.Schema.Type<typeof TokenRequestSchema>;
  readonly jkt: string;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const { provider, body, jkt, now } = params;
    const presented = body.refresh_token;
    const clientId = body.client_id;
    if (presented === undefined || clientId === undefined) {
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description: 'a refresh_token grant needs refresh_token and client_id',
      });
    }

    const found = yield* Effect.result(
      provider.grants.getRefresh({ token: presented, now }),
    );
    if (Result.isFailure(found) || found.success === undefined) {
      return oauthError({
        status: 400,
        error: 'invalid_grant',
        description: 'the refresh token is unknown or expired',
      });
    }
    const grant = found.success;

    if (grant.clientId !== clientId) {
      return oauthError({
        status: 400,
        error: 'invalid_grant',
        description: 'the refresh token was issued to another client',
      });
    }
    if (grant.dpopJkt !== jkt) {
      return oauthError({
        status: 400,
        error: 'invalid_dpop_proof',
        description: 'the proof is not from the key this grant is bound to',
      });
    }

    // a grant outlives the request that made it, so the credential behind it is
    // asked about again: one revoked in the meantime must not keep minting for the
    // life of its refresh token
    const live = yield* provider.credentials.live({
      did: grant.did,
      credential: grant.credential,
    });
    if (!live) {
      yield* provider.grants.deleteRefresh({ token: presented });
      return oauthError({
        status: 400,
        error: 'invalid_grant',
        description: 'the credential behind this grant is no longer live',
      });
    }

    // rotation: the presented token is spent whether or not the rest succeeds
    yield* provider.grants.deleteRefresh({ token: presented });
    return yield* issueFor({
      did: grant.did,
      scope: grant.scope,
      jkt: grant.dpopJkt,
      clientId: grant.clientId,
      credential: grant.credential,
      now,
    });
  });

/** Exchange an authorization code, or a refresh token, for tokens. */
const token = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const now = nowSeconds();

    const guard = yield* requireDpop({ request, provider, htm: 'POST', now });
    if (!guard.ok) {
      return guard.response;
    }
    const jkt = guard.jkt;

    const parsed = yield* Effect.result(
      HttpServerRequest.schemaBodyUrlParams(TokenRequestSchema),
    );
    if (Result.isFailure(parsed)) {
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description: 'the body is not a token request',
      });
    }
    const body = parsed.success;

    if (body.grant_type === 'authorization_code') {
      const response = yield* exchangeAuthorizationCode({
        provider,
        body,
        jkt,
        now,
      });
      return withDpopNonce({ response, nonce: guard.nonce });
    }

    if (body.grant_type === 'refresh_token') {
      const response = yield* refreshGrant({ provider, body, jkt, now });
      return withDpopNonce({ response, nonce: guard.nonce });
    }
    return withDpopNonce({
      response: oauthError({
        status: 400,
        error: 'unsupported_grant_type',
        description: `${body.grant_type} is not a grant this provider supports`,
      }),
      nonce: guard.nonce,
    });
  });

/**
 * Revocation, per RFC 7009: revoking a token we do not know is still a success, so
 * this cannot be used to probe which tokens exist.
 */
const revoke = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const now = nowSeconds();

    const guard = yield* requireDpop({ request, provider, htm: 'POST', now });
    if (!guard.ok) {
      return guard.response;
    }

    const parsed = yield* Effect.result(
      HttpServerRequest.schemaBodyUrlParams(
        Schema.Struct({
          token: Schema.String,
          client_id: Schema.optionalKey(Schema.String),
          token_type_hint: Schema.optionalKey(Schema.String),
        }),
      ),
    );
    if (Result.isFailure(parsed)) {
      // a malformed request is the one case that is not silently a success
      return oauthError({
        status: 400,
        error: 'invalid_request',
        description: 'the body is not a revocation request',
      });
    }

    const found = yield* Effect.result(
      provider.grants.getRefresh({ token: parsed.success.token, now }),
    );
    // only the client the grant was issued to may end it
    if (
      !Result.isFailure(found) &&
      found.success !== undefined &&
      found.success.clientId === parsed.success.client_id
    ) {
      yield* provider.grants.deleteRefresh({ token: parsed.success.token });
    }

    return withDpopNonce({
      response: HttpServerResponse.jsonUnsafe({}),
      nonce: guard.nonce,
    });
  });

/** What the server says it is. */
export const metadataRoute = HttpRouter.add(
  'GET',
  '/.well-known/oauth-authorization-server',
  metadata,
);

/** The public half of the token-signing key. */
export const jwksRoute = HttpRouter.add('GET', '/oauth/jwks', jwks);

/** The pushed authorization request endpoint. */
export const parRoute = HttpRouter.add(
  'POST',
  '/oauth/par',
  pushedAuthorizationRequest,
);

/** The consent page and the decision it posts back. */
export const authorizationPageRoute = HttpRouter.add(
  'GET',
  '/oauth/authorize',
  authorizationPage,
);
export const authorizationDecisionRoute = HttpRouter.add(
  'POST',
  '/oauth/authorize',
  authorizationDecision,
);

/** The token endpoint. */
export const tokenRoute = HttpRouter.add('POST', '/oauth/token', token);

/** The revocation endpoint. */
export const revokeRoute = HttpRouter.add('POST', '/oauth/revoke', revoke);

/** The provider, as routes to mount beside a server's own. */
export const providerRoutes = Layer.mergeAll(
  metadataRoute,
  jwksRoute,
  parRoute,
  authorizationPageRoute,
  authorizationDecisionRoute,
  tokenRoute,
  revokeRoute,
);
