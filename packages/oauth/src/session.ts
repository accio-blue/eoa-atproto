/**
 * The session a login produces, and where it is kept.
 *
 * The shape is deliberately what a *request* needs and nothing more: a token, the
 * key confirmation it is bound to, and the endpoint to refresh at. Re-deriving
 * any of it per request would mean re-discovering the authorization server on
 * every call.
 */

/** A logged-in account. */
export interface OAuthSession {
  readonly did: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly scope: string;
  /** Seconds since the epoch, when the access token stops being usable. */
  readonly expiresAt?: number;
  readonly issuer: string;
  /** The resource server this token is for: where signed requests go. */
  readonly pdsUrl: string;
  readonly tokenEndpoint: string;
  /** Where to revoke, when the server advertises one. */
  readonly revocationEndpoint?: string;
  /** The DPoP key confirmation the token was issued for (`cnf.jkt`). */
  readonly dpopJkt: string;
}

/**
 * Where sessions live between runs. A plugin persists them; a test keeps them in
 * memory. All three take a single object, so an implementation cannot quietly
 * grow a second positional argument.
 */
export interface SessionStore {
  readonly get: (params: {
    readonly did: string;
  }) => Promise<OAuthSession | undefined>;
  readonly set: (params: { readonly session: OAuthSession }) => Promise<void>;
  readonly delete: (params: { readonly did: string }) => Promise<void>;
}

/** A store that forgets everything when the process ends. */
export const memorySessionStore = (): SessionStore => {
  const sessions = new Map<string, OAuthSession>();
  return {
    get: async ({ did }) => sessions.get(did),
    set: async ({ session }) => {
      sessions.set(session.did, session);
    },
    delete: async ({ did }) => {
      sessions.delete(did);
    },
  };
};

/**
 * The per-origin DPoP nonce the server last handed us. Kept per origin because a
 * nonce is scoped to the server that issued it, and sending another server's
 * nonce would read as a replay.
 */
export interface NonceStore {
  readonly get: (params: {
    readonly origin: string;
  }) => Promise<string | undefined>;
  readonly set: (params: {
    readonly origin: string;
    readonly nonce: string;
  }) => Promise<void>;
}

/** A nonce store that forgets everything when the process ends. */
export const memoryNonceStore = (): NonceStore => {
  const nonces = new Map<string, string>();
  return {
    get: async ({ origin }) => nonces.get(origin),
    set: async ({ origin, nonce }) => {
      nonces.set(origin, nonce);
    },
  };
};

/** Whether a token is close enough to expiry to refresh before using it. */
export const isExpiring = (params: {
  readonly session: OAuthSession;
  readonly now: number;
  readonly marginSeconds?: number;
}): boolean => {
  if (params.session.expiresAt === undefined) {
    return false;
  }
  return params.session.expiresAt - params.now <= (params.marginSeconds ?? 30);
};
