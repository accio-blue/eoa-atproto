import { Effect, Schema } from 'effect';

/**
 * The two things a grant is made of: an authorization code, which is short-lived and
 * used exactly once, and a refresh token, which is the long-lived half.
 *
 * Both are keyed by an opaque value and both carry the DPoP key the grant is bound
 * to, because that binding has to survive the trip through the browser: the client
 * proves the same key at the token endpoint that it committed to at the push.
 */

/** Reported when a grant cannot be stored or read. */
export class GrantError extends Schema.TaggedError<GrantError>()('GrantError', {
  message: Schema.String,
}) {}

/** An authorization code, as it was minted for one client and one account. */
export interface AuthorizationCode {
  readonly code: string;
  readonly clientId: string;
  readonly did: string;
  readonly scope: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  /** The key the grant is bound to, when the client committed to one at the push. */
  readonly dpopJkt: string | undefined;
  /**
   * The credential that authorised it, opaque to the provider. Carried onto the
   * refresh token so a later refresh can ask whether it is still live.
   */
  readonly credential: string;
  readonly expiresAt: number;
}

/** The long-lived half of a grant. */
export interface RefreshToken {
  readonly token: string;
  readonly clientId: string;
  readonly did: string;
  readonly scope: string;
  readonly dpopJkt: string;
  readonly credential: string;
  readonly expiresAt: number;
}

/** Where grants live between the authorization and the tokens. */
export interface GrantStore {
  readonly putCode: (
    code: AuthorizationCode,
  ) => Effect.Effect<void, GrantError>;
  /**
   * Take a code: reading it consumes it. A second exchange of the same code finds
   * nothing, which is what makes the code single-use rather than single-checked.
   */
  readonly takeCode: (params: {
    readonly code: string;
    readonly now: number;
  }) => Effect.Effect<AuthorizationCode | undefined, GrantError>;
  readonly putRefresh: (token: RefreshToken) => Effect.Effect<void, GrantError>;
  readonly getRefresh: (params: {
    readonly token: string;
    readonly now: number;
  }) => Effect.Effect<RefreshToken | undefined, GrantError>;
  readonly deleteRefresh: (params: {
    readonly token: string;
  }) => Effect.Effect<void, GrantError>;
}

/** A store that forgets everything when the process ends. */
export const memoryGrants = (): GrantStore => {
  const codes = new Map<string, AuthorizationCode>();
  const refreshTokens = new Map<string, RefreshToken>();

  return {
    putCode: (code) =>
      Effect.sync(() => {
        codes.set(code.code, code);
      }),
    takeCode: ({ code, now }) =>
      Effect.sync(() => {
        const found = codes.get(code);
        // consumed whether or not it was still valid: a code is never presented twice
        codes.delete(code);
        if (found === undefined || found.expiresAt <= now) {
          return undefined;
        }
        return found;
      }),
    putRefresh: (token) =>
      Effect.sync(() => {
        refreshTokens.set(token.token, token);
      }),
    getRefresh: ({ token, now }) =>
      Effect.sync(() => {
        const found = refreshTokens.get(token);
        if (found === undefined) {
          return undefined;
        }
        if (found.expiresAt <= now) {
          refreshTokens.delete(token);
          return undefined;
        }
        return found;
      }),
    deleteRefresh: ({ token }) =>
      Effect.sync(() => {
        refreshTokens.delete(token);
      }),
  };
};
