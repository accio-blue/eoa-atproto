import type { Account, AccountStore, Session } from './account-store.js';
import {
  AuthRequestError,
  type AuthRequestStore,
  type AuthorizationRequest,
  type CredentialLiveness,
  GrantError,
  type GrantStore,
  type RefreshToken,
  type SessionResolver,
  type SessionView,
  httpClientMetadata,
  makeProvider,
  makeTokenKeys,
  providerLayer,
  providerRoutes,
} from '@eoa/oauth-provider';
import { Effect, Layer, Option, Result, Schema } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { base64urlEncode, importPrivateKey, sha256 } from '@eoa/crypto';
import { deleteOp, putOp } from '@eoa/kv';
import { randomId, verifyPassword } from './password.js';
import type { FetchLike } from '@eoa/oauth';
import type { Kv } from '@eoa/kv';
import type { PdsConfig } from './pds.js';

/**
 * The PDS as its own authorization server.
 *
 * The protocol lives in `@eoa/oauth-provider`; this file is the deployment half
 * it deliberately does not own: where the pushed requests and grants are kept,
 * who the browser is, and what a sign-in means on *this* account store.
 *
 * The identity half is the part a reader should not skim. An OAuth client sends
 * a browser to a consent page, and a browser arrives with a cookie and nothing
 * else — no bearer token, no DPoP key. So the PDS needs its own browser session,
 * separate from `createSession`'s JWTs: a row in the account store (so deleting
 * the session ends every grant it authorised) and a cookie that names it. The
 * cookie carries `<did>:<id>` because a session row is keyed by both, and the id
 * is 32 random bytes — the credential is the secret, not the cookie's shape.
 *
 * One thing is deliberately in memory: the DPoP nonce. Losing it (an object that
 * is evicted between two calls) makes the next proof stale, and the protocol's
 * own answer to that is a fresh nonce and one retry — which is exactly what a
 * client already does. The pushed requests and the grants are rows, because they
 * must survive a restart to mean anything.
 */

/** The cookie that names a browser session. */
const SESSION_COOKIE = 'pds_oauth';

/** How long a browser session lasts: the grant's own refresh lifetime. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const AUTH_REQUEST_PREFIX = 'O/R/';

const CODE_PREFIX = 'O/C/';

const REFRESH_PREFIX = 'O/G/';

const encoder = new TextEncoder();

const utf8 = (value: string) => encoder.encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const nowMs = () => Date.now();

/** A store that could not answer, said in the provider's own words. */
class OAuthIssuerError extends Schema.TaggedError<OAuthIssuerError>()(
  'OAuthIssuerError',
  { message: Schema.String },
) {}

const issuerError = (message: string) => new OAuthIssuerError({ message });

/** Read one row and decode it; a row that does not decode is a row that is not there. */
const readRow = <A>(params: {
  readonly kv: Kv['Service'];
  readonly key: string;
  readonly schema: Schema.Codec<A>;
}) =>
  params.kv.get(params.key).pipe(
    Effect.mapError((error) =>
      issuerError(`the row could not be read: ${error._tag}`),
    ),
    Effect.map((found) =>
      Option.isSome(found)
        ? Option.getOrUndefined(
            Schema.decodeUnknownOption(Schema.fromJsonString(params.schema))(
              text(found.value.value),
            ),
          )
        : undefined,
    ),
  );

/** Write one row as JSON. */
const writeRow = <A>(params: {
  readonly kv: Kv['Service'];
  readonly key: string;
  readonly value: A;
  readonly schema: Schema.Codec<A>;
}) =>
  params.kv
    .batch([
      putOp({
        key: params.key,
        value: utf8(
          Schema.encodeSync(Schema.fromJsonString(params.schema))(params.value),
        ),
      }),
    ])
    .pipe(
      Effect.mapError((error) =>
        issuerError(`the row could not be written: ${error._tag}`),
      ),
      Effect.map(() => undefined),
    );

const deleteRow = (params: {
  readonly kv: Kv['Service'];
  readonly key: string;
}) =>
  params.kv.batch([deleteOp({ key: params.key })]).pipe(
    Effect.mapError((error) =>
      issuerError(`the row could not be deleted: ${error._tag}`),
    ),
    Effect.map(() => undefined),
  );

/**
 * The pushed requests, as rows.
 *
 * Optional fields are absent rather than `undefined` in the JSON — that is what
 * the schema reads — and the provider's interfaces spell the same thing as
 * `string | undefined`, so the mapping happens here and only here.
 */
const StoredRequestSchema = Schema.Struct({
  requestUri: Schema.String,
  clientId: Schema.String,
  redirectUri: Schema.String,
  scope: Schema.String,
  state: Schema.optionalKey(Schema.String),
  codeChallenge: Schema.String,
  loginHint: Schema.optionalKey(Schema.String),
  dpopJkt: Schema.optionalKey(Schema.String),
  expiresAt: Schema.Finite,
});

const StoredCodeSchema = Schema.Struct({
  code: Schema.String,
  clientId: Schema.String,
  did: Schema.String,
  scope: Schema.String,
  redirectUri: Schema.String,
  codeChallenge: Schema.String,
  dpopJkt: Schema.optionalKey(Schema.String),
  credential: Schema.String,
  expiresAt: Schema.Finite,
});

const StoredRefreshSchema = Schema.Struct({
  token: Schema.String,
  clientId: Schema.String,
  did: Schema.String,
  scope: Schema.String,
  dpopJkt: Schema.String,
  credential: Schema.String,
  expiresAt: Schema.Finite,
});

/** The provider's store, over the PDS's own key-value rows. */
export const kvAuthRequests = (kv: Kv['Service']): AuthRequestStore => ({
  put: (request) =>
    writeRow({
      kv,
      key: `${AUTH_REQUEST_PREFIX}${request.requestUri}`,
      schema: StoredRequestSchema,
      value: {
        requestUri: request.requestUri,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        scope: request.scope,
        ...(request.state === undefined ? {} : { state: request.state }),
        codeChallenge: request.codeChallenge,
        ...(request.loginHint === undefined
          ? {}
          : { loginHint: request.loginHint }),
        ...(request.dpopJkt === undefined ? {} : { dpopJkt: request.dpopJkt }),
        expiresAt: request.expiresAt,
      },
    }).pipe(
      Effect.mapError(
        (error) => new AuthRequestError({ message: error.message }),
      ),
    ),
  get: ({ requestUri, now }) =>
    readRow({
      kv,
      key: `${AUTH_REQUEST_PREFIX}${requestUri}`,
      schema: StoredRequestSchema,
    }).pipe(
      Effect.mapError(
        (error) => new AuthRequestError({ message: error.message }),
      ),
      Effect.map((stored): AuthorizationRequest | undefined =>
        stored === undefined || stored.expiresAt <= now
          ? undefined
          : {
              requestUri: stored.requestUri,
              clientId: stored.clientId,
              redirectUri: stored.redirectUri,
              scope: stored.scope,
              state: stored.state,
              codeChallenge: stored.codeChallenge,
              loginHint: stored.loginHint,
              dpopJkt: stored.dpopJkt,
              expiresAt: stored.expiresAt,
            },
      ),
    ),
  delete: ({ requestUri }) =>
    deleteRow({ kv, key: `${AUTH_REQUEST_PREFIX}${requestUri}` }).pipe(
      Effect.mapError(
        (error) => new AuthRequestError({ message: error.message }),
      ),
    ),
});

/** Codes and refresh tokens, as rows — a code is consumed by deleting it. */
export const kvGrants = (kv: Kv['Service']): GrantStore => ({
  putCode: (code) =>
    writeRow({
      kv,
      key: `${CODE_PREFIX}${code.code}`,
      schema: StoredCodeSchema,
      value: {
        code: code.code,
        clientId: code.clientId,
        did: code.did,
        scope: code.scope,
        redirectUri: code.redirectUri,
        codeChallenge: code.codeChallenge,
        ...(code.dpopJkt === undefined ? {} : { dpopJkt: code.dpopJkt }),
        credential: code.credential,
        expiresAt: code.expiresAt,
      },
    }).pipe(
      Effect.mapError((error) => new GrantError({ message: error.message })),
    ),
  takeCode: ({ code, now }) =>
    Effect.gen(function* () {
      const row = yield* readRow({
        kv,
        key: `${CODE_PREFIX}${code}`,
        schema: StoredCodeSchema,
      }).pipe(
        Effect.mapError((error) => new GrantError({ message: error.message })),
      );
      // Consumed whether or not it was still valid: a code is never presented twice.
      yield* deleteRow({ kv, key: `${CODE_PREFIX}${code}` }).pipe(
        Effect.ignore,
      );
      return row === undefined || row.expiresAt <= now
        ? undefined
        : {
            code: row.code,
            clientId: row.clientId,
            did: row.did,
            scope: row.scope,
            redirectUri: row.redirectUri,
            codeChallenge: row.codeChallenge,
            dpopJkt: row.dpopJkt,
            credential: row.credential,
            expiresAt: row.expiresAt,
          };
    }),
  putRefresh: (token) =>
    writeRow({
      kv,
      key: `${REFRESH_PREFIX}${token.token}`,
      schema: StoredRefreshSchema,
      value: {
        token: token.token,
        clientId: token.clientId,
        did: token.did,
        scope: token.scope,
        dpopJkt: token.dpopJkt,
        credential: token.credential,
        expiresAt: token.expiresAt,
      },
    }).pipe(
      Effect.mapError((error) => new GrantError({ message: error.message })),
    ),
  getRefresh: ({ token, now }) =>
    readRow({
      kv,
      key: `${REFRESH_PREFIX}${token}`,
      schema: StoredRefreshSchema,
    }).pipe(
      Effect.mapError((error) => new GrantError({ message: error.message })),
      Effect.map((stored): RefreshToken | undefined =>
        stored === undefined || stored.expiresAt <= now
          ? undefined
          : {
              token: stored.token,
              clientId: stored.clientId,
              did: stored.did,
              scope: stored.scope,
              dpopJkt: stored.dpopJkt,
              credential: stored.credential,
              expiresAt: stored.expiresAt,
            },
      ),
    ),
  deleteRefresh: ({ token }) =>
    deleteRow({ kv, key: `${REFRESH_PREFIX}${token}` }).pipe(
      Effect.mapError((error) => new GrantError({ message: error.message })),
    ),
});

/**
 * The CSRF token the consent form carries back.
 *
 * Derived from the session id rather than stored: the page and the decision are
 * two requests, and the provider asks the deployment for the same value twice.
 * A value derived from the cookie is the same both times — and a cross-site POST
 * cannot know it, which is the whole point.
 */
const csrfFor = (sessionId: string) =>
  sha256(utf8(`csrf:${sessionId}`)).pipe(Effect.map(base64urlEncode));

const cookieValueOf = (session: {
  readonly did: string;
  readonly id: string;
}) => `${session.did}:${session.id}`;

/** The session a browser cookie names: `<did>:<id>`, read back from the store. */
const sessionOf = (params: {
  readonly accounts: AccountStore['Service'];
  readonly cookie: string | undefined;
}) =>
  Effect.gen(function* () {
    if (params.cookie === undefined) {
      return undefined;
    }
    const value = decodeURIComponent(params.cookie);
    const at = value.lastIndexOf(':');
    if (at <= 0) {
      return undefined;
    }
    const did = value.slice(0, at);
    const id = value.slice(at + 1);
    const found = yield* params.accounts
      .session(did, id)
      .pipe(Effect.orElseSucceed(() => Option.none<Session>()));
    if (Option.isNone(found) || found.value.expiresAt <= nowMs()) {
      return undefined;
    }
    const account = yield* params.accounts
      .account(did)
      .pipe(Effect.orElseSucceed(() => Option.none<Account>()));
    // A session outlives nothing: a taken-down account stops authorizing too.
    if (Option.isNone(account) || account.value.status !== 'active') {
      return undefined;
    }
    const csrfToken = yield* csrfFor(id);
    return {
      did,
      id,
      csrfToken,
      scopes: undefined,
    };
  });

/** Who the consent page is talking to: the cookie, or nobody. */
const sessionResolver = (
  accounts: AccountStore['Service'],
): SessionResolver => ({
  current: (request) =>
    sessionOf({ accounts, cookie: request.cookies[SESSION_COOKIE] }).pipe(
      Effect.map((found): SessionView | undefined =>
        found === undefined
          ? undefined
          : {
              did: found.did,
              scopes: found.scopes,
              csrfToken: found.csrfToken,
              // The credential a grant records, so ending this session ends it.
              credential: found.id,
            },
      ),
      Effect.orElseSucceed(() => undefined),
    ),
});

/** A grant's credential is the session it was authorised with; deleting it ends the grant. */
const credentialLiveness = (
  accounts: AccountStore['Service'],
): CredentialLiveness => ({
  live: ({ did, credential }) =>
    accounts.session(did, credential).pipe(
      Effect.map(
        (found) => Option.isSome(found) && found.value.expiresAt > nowMs(),
      ),
      Effect.orElseSucceed(() => false),
    ),
});

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const page = (params: {
  readonly title: string;
  readonly body: string;
  readonly status?: number;
}) =>
  HttpServerResponse.setStatus(params.status ?? 200)(
    HttpServerResponse.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(params.title)}</title>` +
        `</head><body style="font-family: system-ui; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">` +
        `<h1>${escapeHtml(params.title)}</h1>${params.body}</body></html>`,
    ),
  );

/** The deployment's sign-in: the provider sends the visitor here when nobody is signed in. */
const signInPage = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.sync(() => {
    const requestUri =
      new URL(request.url, 'http://pds.invalid').searchParams.get(
        'request_uri',
      ) ?? '';
    return page({
      title: 'Sign in',
      body:
        `<form method="post" action="/oauth/sign-in">` +
        `<input type="hidden" name="request_uri" value="${escapeHtml(requestUri)}">` +
        `<p><label>Handle or DID<br><input name="identifier" autocomplete="username" required style="width:100%"></label></p>` +
        `<p><label>Password<br><input name="password" type="password" autocomplete="current-password" required style="width:100%"></label></p>` +
        `<p><button style="padding:.5rem 1rem">Sign in</button></p>` +
        `</form>`,
    });
  });

/** Verifying a password costs work; a missing account must not answer sooner. */
const signIn =
  (params: {
    readonly accounts: AccountStore['Service'];
    readonly secureCookies: boolean;
  }) =>
  (_request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const form = yield* Effect.result(
        HttpServerRequest.schemaBodyUrlParams(
          Schema.Struct({
            identifier: Schema.String.check(Schema.isMinLength(1)),
            password: Schema.String,
            request_uri: Schema.optionalKey(Schema.String),
          }),
        ),
      );
      if (Result.isFailure(form)) {
        return page({
          title: 'Sign in',
          body: '<p>This form is malformed.</p>',
          status: 400,
        });
      }
      const identifier = form.success.identifier.trim();
      const found = yield* (
        identifier.startsWith('did:')
          ? params.accounts.account(identifier)
          : params.accounts.byHandle(identifier.toLowerCase())
      ).pipe(Effect.orElseSucceed(() => Option.none<Account>()));

      const account = Option.getOrUndefined(found);
      // An account that is not here still gets the refusal a wrong password gets.
      const matches =
        account === undefined
          ? false
          : yield* verifyPassword(
              form.success.password,
              account.passwordHash,
            ).pipe(Effect.orElseSucceed(() => false));
      if (account === undefined || !matches || account.status !== 'active') {
        return page({
          title: 'Sign in',
          body:
            '<p>That handle and password do not open an account here.</p>' +
            `<form method="post" action="/oauth/sign-in">` +
            `<input type="hidden" name="request_uri" value="${escapeHtml(form.success.request_uri ?? '')}">` +
            `<p><button style="padding:.5rem 1rem">Try again</button></p></form>`,
          status: 401,
        });
      }

      const session: Session = {
        id: randomId(),
        did: account.did,
        appPasswordName: null,
        createdAt: nowMs(),
        expiresAt: nowMs() + SESSION_TTL_MS,
      };
      yield* params.accounts
        .putSession(session)
        .pipe(
          Effect.mapError(() =>
            issuerError('the sign-in could not be recorded'),
          ),
        );

      const cookie = [
        `${SESSION_COOKIE}=${encodeURIComponent(cookieValueOf(session))}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ...(params.secureCookies ? ['Secure'] : []),
      ].join('; ');

      const back =
        form.success.request_uri === undefined ||
        form.success.request_uri === ''
          ? '/oauth/authorize'
          : `/oauth/authorize?request_uri=${encodeURIComponent(form.success.request_uri)}`;

      return HttpServerResponse.setHeader(
        'set-cookie',
        cookie,
      )(HttpServerResponse.redirect(back, { status: 303 }));
    });

/** What an issuer needs from the deployment around it. */
export interface IssuerParams {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly kv: Kv['Service'];
  /** Where client metadata documents are fetched; injected so a test is not a network. */
  readonly fetch: FetchLike;
}

/**
 * The authorization server, as a Web `Request` → `Response` handler — or nothing
 * when the deployment holds no signing key, because a PDS that cannot sign is not
 * an issuer and should not pretend to be one.
 */
export const createPdsOAuth = (params: IssuerParams) =>
  Effect.gen(function* () {
    const oauth = params.config.oauth;
    if (oauth?.privateJwk === undefined) {
      return undefined;
    }
    const privateKey = yield* importPrivateKey(oauth.privateJwk).pipe(
      Effect.mapError((cause) =>
        issuerError(`the OAuth signing key is not usable: ${cause.message}`),
      ),
    );
    const keys = yield* makeTokenKeys({
      keyPair: { privateKey, publicKey: privateKey.publicKey },
    }).pipe(Effect.mapError((cause) => issuerError(cause.message)));

    const provider = makeProvider({
      issuer: oauth.issuer,
      audience: params.config.did,
      keys,
      clients: httpClientMetadata(params.fetch),
      authRequests: kvAuthRequests(params.kv),
      grants: kvGrants(params.kv),
      sessions: sessionResolver(params.accounts),
      credentials: credentialLiveness(params.accounts),
      signInPath: '/oauth/sign-in',
    });

    const layer = Layer.mergeAll(
      providerRoutes,
      HttpRouter.add('GET', '/oauth/sign-in', signInPage),
      HttpRouter.add(
        'POST',
        '/oauth/sign-in',
        signIn({
          accounts: params.accounts,
          secureCookies: oauth.issuer.startsWith('https:'),
        }),
      ),
      providerLayer(provider),
    );

    return HttpRouter.toWebHandler(layer);
  });
