import { Effect, Schema } from 'effect';

/**
 * The pushed authorization requests: what a client committed to before the user was
 * ever sent to us, keyed by the `request_uri` that stands in for it.
 *
 * It is a store and not a stateless token because PAR's whole purpose is that the
 * parameters never travel through the browser: the client gives them to us, we keep
 * them, and the browser only ever carries an opaque handle to them. So this is
 * deliberately short-lived state — `get` treats an expired request as absent, and
 * the caller cannot forget to.
 */

/** Reported when a request cannot be stored or read. */
export class AuthRequestError extends Schema.TaggedError<AuthRequestError>()(
  'AuthRequestError',
  { message: Schema.String },
) {}

/** One pushed authorization request, as the client committed to it. */
export interface AuthorizationRequest {
  readonly requestUri: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** The scope the client asked for: a narrowing of what its metadata declares. */
  readonly scope: string;
  readonly state: string | undefined;
  readonly codeChallenge: string;
  readonly loginHint: string | undefined;
  /** The DPoP key the client committed to for this request, when it named one. */
  readonly dpopJkt: string | undefined;
  readonly expiresAt: number;
}

/** Where pushed requests live between the push and the authorization. */
export interface AuthRequestStore {
  readonly put: (
    request: AuthorizationRequest,
  ) => Effect.Effect<void, AuthRequestError>;
  readonly get: (params: {
    readonly requestUri: string;
    readonly now: number;
  }) => Effect.Effect<AuthorizationRequest | undefined, AuthRequestError>;
  readonly delete: (params: {
    readonly requestUri: string;
  }) => Effect.Effect<void, AuthRequestError>;
}

/** A store that forgets everything when the process ends. */
export const memoryAuthRequests = (): AuthRequestStore => {
  const requests = new Map<string, AuthorizationRequest>();
  return {
    put: (request) =>
      Effect.sync(() => {
        requests.set(request.requestUri, request);
      }),
    get: ({ requestUri, now }) =>
      Effect.sync(() => {
        const request = requests.get(requestUri);
        if (request === undefined) {
          return undefined;
        }
        // an expired request is not a request
        if (request.expiresAt <= now) {
          requests.delete(requestUri);
          return undefined;
        }
        return request;
      }),
    delete: ({ requestUri }) =>
      Effect.sync(() => {
        requests.delete(requestUri);
      }),
  };
};
