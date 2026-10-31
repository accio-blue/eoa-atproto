import { Context, Effect, Layer } from 'effect';
import { type DpopNonceStore, memoryDpopNonces } from './nonces.js';
import type { AuthRequestStore } from './auth-requests.js';
import type { ClientMetadataSource } from './clients.js';
import type { GrantStore } from './grants.js';
import type { HttpServerRequest } from 'effect/http';
import type { TokenKeysShape } from './keys.js';

/**
 * What a running provider is: who it is, whose tokens it signs, and where the three
 * bits of state it keeps live.
 *
 * The stores are ports rather than implementations because the provider should not
 * decide whether this deployment is one process or many — the PDS supplies its own.
 * Authentication is a port for the same reason: the provider decides *what* an
 * approved authorization means, but who the user is belongs to the deployment.
 */

/**
 * Who the deployment says is signed in.
 *
 * The provider never sees a password, a session or an account: it asks this for the
 * DID behind the request that is being authorized, and takes `undefined` as "nobody".
 */
export interface SessionResolver {
  readonly current: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<SessionView | undefined, never>;
}

/**
 * What the deployment knows about the visitor: who they are, what this session may
 * do, and the token the decide-form has to echo back.
 *
 * All three are the deployment's to answer, because all three are about a session —
 * and the provider has none of its own. `scopes: undefined` means the whole
 * account; a list narrows to exactly those permissions, which is what makes a
 * *scoped* credential enforced rather than merely recorded.
 */
export interface SessionView {
  readonly did: string;
  readonly scopes: readonly string[] | undefined;
  /** A token tied to this session, so a cross-site POST cannot drive the decision. */
  readonly csrfToken: string;
  /**
   * The credential this session signed in with, opaque to the provider. It is
   * recorded on the grant so a revoked credential can end what it authorised.
   */
  readonly credential: string;
}

/**
 * Whether the credential behind a grant may still act.
 *
 * A grant outlives the request that made it: its refresh token is good for weeks,
 * and a credential revoked in the meantime would keep minting access tokens for all
 * of them. So the provider asks the deployment, which is the only side that holds
 * the credential store, before it honours a refresh.
 */
export interface CredentialLiveness {
  readonly live: (params: {
    readonly did: string;
    readonly credential: string;
  }) => Effect.Effect<boolean, never>;
}

/** The provider's configuration. */
export interface ProviderShape {
  /** The issuer identifier: the audience its tokens name as `iss`. */
  readonly issuer: string;
  /** The resource server its tokens are for: the `aud` they carry. */
  readonly audience: string;
  readonly keys: TokenKeysShape;
  readonly clients: ClientMetadataSource;
  readonly authRequests: AuthRequestStore;
  readonly grants: GrantStore;
  readonly sessions: SessionResolver;
  /** Where the provider asks whether a grant's credential is still live. */
  readonly credentials: CredentialLiveness;
  /**
   * Where a signed-out visitor is sent to sign in, when the deployment has a page
   * for it. The provider has no login of its own — that is the deployment's, and
   * the account's — so without this the authorization page is a dead end.
   */
  readonly signInPath?: string;
  /** Where the current DPoP nonce and its jti replay state live. */
  readonly nonces: DpopNonceStore;
  /** How long a pushed authorization request stays usable, in seconds. */
  readonly requestTtlSeconds: number;
  /** How long an authorization code stays exchangeable, in seconds. */
  readonly codeTtlSeconds: number;
  /** How long an access token is good for, in seconds. */
  readonly accessTokenTtlSeconds: number;
  /** How long a refresh token is good for, in seconds. */
  readonly refreshTtlSeconds: number;
}

/** The provider, as a service. */
export class Provider extends Context.Service<Provider, ProviderShape>()(
  'oauth-provider/Provider',
) {}

const TTL_DEFAULTS = {
  requestTtlSeconds: 300,
  codeTtlSeconds: 60,
  accessTokenTtlSeconds: 3600,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
} as const;

/** The configuration a provider runs with, with the defaults filled in. */
export const makeProvider = (
  options: Omit<
    ProviderShape,
    | 'requestTtlSeconds'
    | 'codeTtlSeconds'
    | 'accessTokenTtlSeconds'
    | 'refreshTtlSeconds'
    | 'nonces'
  > &
    Partial<{
      requestTtlSeconds: number;
      codeTtlSeconds: number;
      accessTokenTtlSeconds: number;
      refreshTtlSeconds: number;
      nonces: DpopNonceStore;
    }>,
): ProviderShape => ({
  ...options,
  nonces: options.nonces ?? memoryDpopNonces(),
  requestTtlSeconds:
    options.requestTtlSeconds ?? TTL_DEFAULTS.requestTtlSeconds,
  // short by design: a code is a hand-off, not a credential
  codeTtlSeconds: options.codeTtlSeconds ?? TTL_DEFAULTS.codeTtlSeconds,
  accessTokenTtlSeconds:
    options.accessTokenTtlSeconds ?? TTL_DEFAULTS.accessTokenTtlSeconds,
  refreshTtlSeconds:
    options.refreshTtlSeconds ?? TTL_DEFAULTS.refreshTtlSeconds,
});

/** A provider, as a Layer. */
export const providerLayer = (
  options: Parameters<typeof makeProvider>[0],
): Layer.Layer<Provider> => Layer.succeed(Provider, makeProvider(options));
