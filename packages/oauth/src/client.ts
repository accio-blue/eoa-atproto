import { Effect, Option, Schema } from 'effect';
import {
  type FetchLike,
  errorCodeOf,
  formBody,
  jsonDecoded,
  responseText,
  send,
} from './http.js';
import {
  type NonceStore,
  type OAuthSession,
  type SessionStore,
  isExpiring,
  memoryNonceStore,
} from './session.js';
import { challengeFor, createVerifier } from './pkce.js';
import { createProof, dpopKeyThumbprint } from './dpop.js';
import type { PrivateKey } from '@eoa/crypto';
import { discoverAuthorizationServer } from './discovery.js';

/**
 * The client half of the atproto OAuth profile: PAR, the authorization URL, the
 * token exchange and refresh, and a DPoP-signed request. It is the counterpart of
 * the provider (M3), and it is what lets an app talk to *any* atproto
 * authorization server — ours or bsky.social — without a vendored client.
 *
 * The whole of DPoP is one function below (`dpopRequest`): sign the request, send
 * it, and if the server answers `use_dpop_nonce`, store its nonce and send it
 * again. PAR, the token endpoint, refresh, revoke and ordinary resource requests
 * all go through it, so the nonce rule exists once.
 *
 * Deliberate choices worth stating:
 *
 * - **PAR is required.** An authorization server that does not advertise
 *   `pushed_authorization_request_endpoint` is refused rather than fall back to a
 *   front-channel request, because the fallback is where the parameters leak into
 *   browser history and referrers.
 * - **A token must be DPoP-bound.** A `DPoP` token type is required and, when the
 *   server names a key (`cnf.jkt`), it must be *our* key. Accepting a bearer
 *   token here would silently undo the binding the proof just established.
 * - **The issuer is checked** when the callback echoes one (RFC 9207), so a
 *   callback from another authorization server cannot be replayed into us.
 */

/** Reported when a login or a signed request cannot be completed. */
export class OAuthClientError extends Schema.TaggedError<OAuthClientError>()(
  'OAuthClientError',
  {
    message: Schema.String,
    /** The OAuth error code, when the server named one (`invalid_grant`, ...). */
    code: Schema.optionalKey(Schema.String),
  },
) {}

const ParResponseSchema = Schema.Struct({
  request_uri: Schema.String,
  expires_in: Schema.optionalKey(Schema.Finite),
});

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  sub: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
  cnf: Schema.optionalKey(
    Schema.Struct({ jkt: Schema.optionalKey(Schema.String) }),
  ),
});

/**
 * The endpoints a token response does not tell us, remembered between the two halves.
 *
 * In a browser the two halves are two page loads: the client pushes the request,
 * the browser leaves for the consent page, and comes back to a fresh process with
 * an empty map. So this is a port like the session store — a page keeps it in
 * `sessionStorage`, a test keeps it in memory.
 */
export interface PendingAuthorization {
  readonly verifier: string;
  readonly issuer: string;
  readonly pdsUrl: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string | undefined;
  /** The callback this login used, which the token exchange must repeat. */
  readonly redirectUri: string;
}

export interface PendingStore {
  readonly get: (params: {
    readonly state: string;
  }) => Promise<PendingAuthorization | undefined>;
  readonly set: (params: {
    readonly state: string;
    readonly authorization: PendingAuthorization;
  }) => Promise<void>;
  readonly delete: (params: { readonly state: string }) => Promise<void>;
}

/** A store that forgets everything when the process ends. */
export const memoryPending = (): PendingStore => {
  const pending = new Map<string, PendingAuthorization>();
  return {
    get: async ({ state }) => pending.get(state),
    set: async ({ state, authorization }) => {
      pending.set(state, authorization);
    },
    delete: async ({ state }) => {
      pending.delete(state);
    },
  };
};

export interface OAuthClientOptions {
  /** The client metadata URL, or a loopback client id. */
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  /** The DPoP key. Its lifetime is the caller's problem, not this client's. */
  readonly key: PrivateKey;
  readonly fetch: FetchLike;
  readonly sessions: SessionStore;
  readonly pending?: PendingStore;
  readonly nonces?: NonceStore;
  /** Seconds since the epoch; injectable so freshness is testable. */
  readonly now?: () => number;
}

export interface OAuthClient {
  readonly createAuthorizationUrl: (params: {
    readonly pdsUrl: string;
    readonly identifier: string;
    /**
     * Where this particular login comes back to. A loopback client id declares
     * its callback without a port, so a native app binds a free port per login
     * and passes the real one here.
     */
    readonly redirectUri?: string;
  }) => Effect.Effect<{ url: string; state: string }, OAuthClientError>;
  readonly finalizeAuthorization: (params: {
    readonly params: URLSearchParams;
  }) => Effect.Effect<OAuthSession, OAuthClientError>;
  readonly refreshSession: (params: {
    readonly session: OAuthSession;
  }) => Effect.Effect<OAuthSession, OAuthClientError>;
  readonly getSession: (params: {
    readonly did: string;
  }) => Effect.Effect<OAuthSession | undefined, OAuthClientError>;
  readonly deleteSession: (params: {
    readonly did: string;
  }) => Effect.Effect<void, OAuthClientError>;
  readonly revokeSession: (params: {
    readonly session: OAuthSession;
  }) => Effect.Effect<void, OAuthClientError>;
  /** A request carrying the session's token and a proof bound to it. */
  readonly signedFetch: (params: {
    readonly did: string;
    readonly url: string;
    readonly init?: RequestInit;
  }) => Effect.Effect<Response, OAuthClientError>;
}

/**
 * Every failure this client can raise, flattened to what a caller can report.
 * An `OAuthClientError` is passed through with its `code` intact, so hoisting this
 * to the end of a generator cannot lose the server's own error name.
 */
const toClientError = (cause: {
  readonly message: string;
  readonly code?: string | undefined;
}): OAuthClientError =>
  new OAuthClientError(
    cause.code === undefined
      ? { message: cause.message }
      : { message: cause.message, code: cause.code },
  );

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const randomState = (): string =>
  // a state only has to be unguessable, not secret-keeping after the round trip
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

export const makeOAuthClient = (options: OAuthClientOptions): OAuthClient => {
  const nonces = options.nonces ?? memoryNonceStore();
  const now = options.now ?? nowSeconds;
  const pending = options.pending ?? memoryPending();

  const readJson = <S extends Schema.ConstraintDecoder<unknown>>(params: {
    readonly response: Response;
    readonly schema: S;
    readonly what: string;
  }): Effect.Effect<S['Type'], OAuthClientError> =>
    Effect.gen(function* () {
      const text = yield* responseText(params.response).pipe(
        Effect.mapError(toClientError),
      );
      const decoded = jsonDecoded({ schema: params.schema, text });
      if (Option.isSome(decoded)) {
        return decoded.value;
      }

      // the server answered something else: prefer its own error code
      const code = errorCodeOf(text);
      if (Option.isSome(code)) {
        return yield* new OAuthClientError({
          message: `${params.what} failed: ${code.value}`,
          code: code.value,
        });
      }
      return yield* new OAuthClientError({
        message: `${params.what} failed: ${params.response.status}`,
      });
    });

  /**
   * Whether this response is the server asking for a DPoP nonce, and the response
   * the caller should see if it is not. A resource server says so with a 401 and
   * a `WWW-Authenticate` challenge; an authorization server, with a 400 and an
   * error body — whose body we hand back, since we had to read it.
   */
  const inspectNonceError = (params: {
    readonly response: Response;
    readonly isAuthServer: boolean;
  }): Effect.Effect<{ isNonceError: boolean; response: Response }, never> =>
    Effect.gen(function* () {
      const { response, isAuthServer } = params;
      if (isAuthServer && response.status === 400) {
        const text = yield* responseText(response).pipe(
          Effect.orElseSucceed(() => ''),
        );
        const code = errorCodeOf(text);
        return {
          isNonceError: Option.isSome(code) && code.value === 'use_dpop_nonce',
          response: new Response(text, {
            status: response.status,
            headers: response.headers,
          }),
        };
      }
      if (!isAuthServer && response.status === 401) {
        const challenge = response.headers.get('WWW-Authenticate');
        return {
          isNonceError:
            challenge !== null &&
            challenge.startsWith('DPoP') &&
            challenge.includes('error="use_dpop_nonce"'),
          response,
        };
      }
      return { isNonceError: false, response };
    });

  const rememberNonce = (params: {
    readonly origin: string;
    readonly nonce: string;
  }) =>
    Effect.tryPromise({
      try: () => nonces.set({ origin: params.origin, nonce: params.nonce }),
      catch: (cause) =>
        new OAuthClientError({
          message: `could not store the nonce: ${String(cause)}`,
        }),
    });

  /** One attempt, with whatever nonce we currently hold. */
  const attempt = (params: {
    readonly url: string;
    readonly method: string;
    readonly fields?: Readonly<Record<string, string | undefined>>;
    readonly body?: string | Uint8Array<ArrayBuffer>;
    readonly headers?: HeadersInit;
    readonly accessToken?: string;
    readonly nonce: string | undefined;
  }): Effect.Effect<Response, OAuthClientError> =>
    Effect.gen(function* () {
      const proof = yield* createProof({
        key: options.key,
        htm: params.method,
        htu: params.url,
        ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
        ...(params.accessToken === undefined
          ? {}
          : { accessToken: params.accessToken }),
      });

      const headers = new Headers(params.headers);
      headers.set('DPoP', proof);
      const body =
        params.fields === undefined ? params.body : formBody(params.fields);
      if (params.fields !== undefined) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }
      if (params.accessToken !== undefined) {
        headers.set('Authorization', `DPoP ${params.accessToken}`);
      }

      return yield* send({
        fetch: options.fetch,
        url: params.url,
        method: params.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    }).pipe(Effect.mapError(toClientError));

  /** Sign, send, and retry once if the server hands us a nonce it wants used. */
  const dpopRequest = (params: {
    readonly url: string;
    readonly method: string;
    readonly fields?: Readonly<Record<string, string | undefined>>;
    readonly body?: string | Uint8Array<ArrayBuffer>;
    readonly headers?: HeadersInit;
    readonly accessToken?: string;
    readonly isAuthServer: boolean;
  }): Effect.Effect<Response, OAuthClientError> =>
    Effect.gen(function* () {
      const origin = new URL(params.url).origin;
      const stored = yield* Effect.tryPromise({
        try: () => nonces.get({ origin }),
        catch: (cause) =>
          new OAuthClientError({
            message: `could not read the nonce: ${String(cause)}`,
          }),
      });

      const send1 = (nonce: string | undefined) =>
        attempt({ ...params, nonce });

      const first = yield* send1(stored === undefined ? undefined : stored);
      const issued = first.headers.get('DPoP-Nonce');
      if (issued === null || issued === stored) {
        return first;
      }

      yield* rememberNonce({ origin, nonce: issued });

      const inspected = yield* inspectNonceError({
        response: first,
        isAuthServer: params.isAuthServer,
      });
      if (!inspected.isNonceError) {
        return inspected.response;
      }

      // The server consumes the nonce it accepted and rotates, so the *retry*
      // response carries the nonce the next request has to present. Reading only
      // the first response leaves a stale nonce behind, and every later request
      // pays for a challenge it never needed.
      const retried = yield* send1(issued);
      const rotated = retried.headers.get('DPoP-Nonce');
      if (rotated !== null && rotated !== issued) {
        yield* rememberNonce({ origin, nonce: rotated });
      }
      return retried;
    });

  const sessionFromToken = (params: {
    readonly token: Schema.Schema.Type<typeof TokenResponseSchema>;
    readonly issuer: string;
    readonly pdsUrl: string;
    readonly tokenEndpoint: string;
    readonly revocationEndpoint: string | undefined;
    readonly fallbackScope: string;
    readonly fallbackRefreshToken: string | undefined;
  }): Effect.Effect<OAuthSession, OAuthClientError> =>
    Effect.gen(function* () {
      const token = params.token;
      if (token.token_type !== 'DPoP') {
        return yield* new OAuthClientError({
          message: `the server issued a ${token.token_type} token, not a DPoP-bound one`,
        });
      }

      const jkt = yield* dpopKeyThumbprint(options.key).pipe(
        Effect.mapError(toClientError),
      );
      const bound = token.cnf?.jkt;
      if (bound !== undefined && bound !== jkt) {
        return yield* new OAuthClientError({
          message: 'the access token is bound to a different key',
        });
      }

      const refreshToken = token.refresh_token ?? params.fallbackRefreshToken;
      return {
        did: token.sub,
        accessToken: token.access_token,
        scope: token.scope ?? params.fallbackScope,
        issuer: params.issuer,
        pdsUrl: params.pdsUrl,
        tokenEndpoint: params.tokenEndpoint,
        dpopJkt: bound ?? jkt,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(params.revocationEndpoint === undefined
          ? {}
          : { revocationEndpoint: params.revocationEndpoint }),
        ...(token.expires_in === undefined
          ? {}
          : { expiresAt: now() + token.expires_in }),
      };
    });

  const putSession = (session: OAuthSession) =>
    Effect.tryPromise({
      try: () => options.sessions.set({ session }),
      catch: (cause) =>
        new OAuthClientError({
          message: `could not store the session: ${String(cause)}`,
        }),
    });

  const refreshSession: OAuthClient['refreshSession'] = ({ session }) =>
    Effect.gen(function* () {
      const refreshToken = session.refreshToken;
      if (refreshToken === undefined) {
        return yield* new OAuthClientError({
          message: 'this session has no refresh token',
          code: 'invalid_grant',
        });
      }

      const response = yield* dpopRequest({
        url: session.tokenEndpoint,
        method: 'POST',
        isAuthServer: true,
        fields: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: options.clientId,
        },
      });
      const token = yield* readJson({
        response,
        schema: TokenResponseSchema,
        what: 'token refresh',
      });

      const next = yield* sessionFromToken({
        token,
        issuer: session.issuer,
        pdsUrl: session.pdsUrl,
        tokenEndpoint: session.tokenEndpoint,
        revocationEndpoint: session.revocationEndpoint,
        fallbackScope: session.scope,
        // a server that rotates sends a new one; one that does not keeps ours
        fallbackRefreshToken: refreshToken,
      });
      yield* putSession(next);
      return next;
    });

  return {
    createAuthorizationUrl: ({
      pdsUrl,
      identifier,
      redirectUri = options.redirectUri,
    }) =>
      Effect.gen(function* () {
        const server = yield* discoverAuthorizationServer({
          fetch: options.fetch,
          pdsUrl,
        }).pipe(Effect.mapError(toClientError));

        const parEndpoint = server.parEndpoint;
        if (parEndpoint === undefined) {
          return yield* new OAuthClientError({
            message: `${server.issuer} does not support pushed authorization requests`,
          });
        }

        const verifier = createVerifier();
        const codeChallenge = yield* challengeFor(verifier).pipe(
          Effect.mapError(toClientError),
        );
        const state = randomState();
        const jkt = yield* dpopKeyThumbprint(options.key).pipe(
          Effect.mapError(toClientError),
        );

        const response = yield* dpopRequest({
          url: parEndpoint,
          method: 'POST',
          isAuthServer: true,
          fields: {
            client_id: options.clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            scope: options.scope,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            login_hint: identifier,
            // bind the request itself to the key that will present the proof
            dpop_jkt: jkt,
          },
        });
        const par = yield* readJson({
          response,
          schema: ParResponseSchema,
          what: 'pushed authorization request',
        });

        yield* Effect.tryPromise({
          try: () =>
            pending.set({
              state,
              authorization: {
                verifier,
                issuer: server.issuer,
                pdsUrl,
                tokenEndpoint: server.tokenEndpoint,
                revocationEndpoint: server.revocationEndpoint,
                redirectUri,
              },
            }),
          catch: (cause) =>
            new OAuthClientError({
              message: `could not remember the login: ${String(cause)}`,
            }),
        });

        const url = new URL(server.authorizationEndpoint);
        url.searchParams.set('client_id', options.clientId);
        url.searchParams.set('request_uri', par.request_uri);
        return { url: url.toString(), state };
      }),

    finalizeAuthorization: ({ params }) =>
      Effect.gen(function* () {
        const refused = params.get('error');
        if (refused !== null) {
          const description = params.get('error_description');
          return yield* new OAuthClientError({
            message: `authorization was refused: ${refused}${description === null ? '' : ` (${description})`}`,
            code: refused,
          });
        }

        const code = params.get('code');
        const state = params.get('state');
        if (code === null || state === null) {
          return yield* new OAuthClientError({
            message: 'the callback carries no code and state',
          });
        }

        const request = yield* Effect.tryPromise({
          try: () => pending.get({ state }),
          catch: (cause) =>
            new OAuthClientError({
              message: `could not read the login: ${String(cause)}`,
            }),
        });
        if (request === undefined) {
          return yield* new OAuthClientError({
            message: 'the callback does not match a login this client started',
          });
        }
        // single use: a replayed callback must not exchange twice
        yield* Effect.tryPromise({
          try: () => pending.delete({ state }),
          catch: (cause) =>
            new OAuthClientError({
              message: `could not forget the login: ${String(cause)}`,
            }),
        });

        // RFC 9207: refuse a callback that names an issuer we did not start at
        const issuer = params.get('iss');
        if (issuer !== null && issuer !== request.issuer) {
          return yield* new OAuthClientError({
            message: `the callback is from ${issuer}, but this login started at ${request.issuer}`,
          });
        }

        const response = yield* dpopRequest({
          url: request.tokenEndpoint,
          method: 'POST',
          isAuthServer: true,
          fields: {
            grant_type: 'authorization_code',
            code,
            redirect_uri: request.redirectUri,
            client_id: options.clientId,
            code_verifier: request.verifier,
          },
        });
        const token = yield* readJson({
          response,
          schema: TokenResponseSchema,
          what: 'token exchange',
        });

        const session = yield* sessionFromToken({
          token,
          issuer: request.issuer,
          pdsUrl: request.pdsUrl,
          tokenEndpoint: request.tokenEndpoint,
          revocationEndpoint: request.revocationEndpoint,
          fallbackScope: options.scope,
          fallbackRefreshToken: undefined,
        });
        yield* putSession(session);
        return session;
      }),

    refreshSession,

    getSession: ({ did }) =>
      Effect.tryPromise({
        try: () => options.sessions.get({ did }),
        catch: (cause) =>
          new OAuthClientError({
            message: `could not read the session: ${String(cause)}`,
          }),
      }),

    deleteSession: ({ did }) =>
      Effect.tryPromise({
        try: () => options.sessions.delete({ did }),
        catch: (cause) =>
          new OAuthClientError({
            message: `could not delete the session: ${String(cause)}`,
          }),
      }),

    revokeSession: ({ session }) =>
      Effect.gen(function* () {
        const endpoint = session.revocationEndpoint;
        if (endpoint !== undefined) {
          yield* dpopRequest({
            url: endpoint,
            method: 'POST',
            isAuthServer: true,
            fields: {
              client_id: options.clientId,
              token: session.refreshToken ?? session.accessToken,
              token_type_hint:
                session.refreshToken === undefined
                  ? 'access_token'
                  : 'refresh_token',
            },
          });
        }
        // the session goes either way: a server that will not revoke is gone from us
        yield* Effect.tryPromise({
          try: () => options.sessions.delete({ did: session.did }),
          catch: (cause) =>
            new OAuthClientError({
              message: `could not delete the session: ${String(cause)}`,
            }),
        });
      }),

    signedFetch: ({ did, url, init }) =>
      Effect.gen(function* () {
        const stored = yield* Effect.tryPromise({
          try: () => options.sessions.get({ did }),
          catch: (cause) =>
            new OAuthClientError({
              message: `could not read the session: ${String(cause)}`,
            }),
        });
        if (stored === undefined) {
          return yield* new OAuthClientError({
            message: `no session for ${did}`,
          });
        }

        const session = isExpiring({ session: stored, now: now() })
          ? yield* refreshSession({ session: stored })
          : stored;

        const body = init?.body;
        if (
          body !== undefined &&
          body !== null &&
          typeof body !== 'string' &&
          !(body instanceof Uint8Array)
        ) {
          return yield* new OAuthClientError({
            message: 'signedFetch carries a string or bytes, not a stream',
          });
        }

        // A view of a body is not a body: copy the bytes so the type says what it is.
        const carried: string | Uint8Array<ArrayBuffer> | undefined =
          typeof body === 'string'
            ? body
            : body instanceof Uint8Array
              ? new Uint8Array(body)
              : undefined;

        return yield* dpopRequest({
          url,
          method: init?.method ?? 'GET',
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          accessToken: session.accessToken,
          isAuthServer: false,
          ...(carried === undefined ? {} : { body: carried }),
        });
      }),
  };
};
