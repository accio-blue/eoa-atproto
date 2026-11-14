import { DEFAULT_ACCESS_TIMEOUT, SPACE_METHODS } from '@eoa/space-host';
import { Data, Duration, Effect, Option, Result, Schema } from 'effect';
import { type IdentityResolver, resolveServiceEndpoint } from '@eoa/identity';
import { type PrivateKey } from '@eoa/crypto';
import { serviceAuthToken } from './token.js';

/**
 * Asking a `managedspace`'s **managing app** whether a user may do something
 * (`com.atproto.managedspace.checkAccess`, proposal `0016`).
 *
 * The app is served by the app, not by this PDS: the authority resolves the
 * policy's `managingApp` (a DID and a fragment) to its endpoint, signs a
 * service-auth token as itself, and asks. The answer is `{ read, write }` — two
 * fields, one per access kind, so an app can allow a write and refuse a read.
 *
 * Every way of not getting a yes is a no. That is the spec's own rule — the
 * proposal makes the host's failure to decide a refusal — and it is also why the
 * verdict carries a `reason`: an operator reading a 403 has to be able to tell
 * "the app considered this user and said no" from "the app never answered", and
 * the two are fixed in completely different places.
 */

/** The access kinds the callback accepts. A write has no client dimension. */
export type ManagedAccess = 'read' | 'write';

/**
 * Why a managed decision did not allow. The set is the *failure taxonomy*: each
 * one names a different thing to go and fix.
 */
export type ManagingAppDenial =
  /** The app answered, and the field for the access asked about was `false`. */
  | 'the-app-denied'
  /** The policy's `managingApp` did not resolve to an endpoint. */
  | 'unresolvable'
  /** The endpoint was named, and the request to it failed. */
  | 'unreachable'
  /** The endpoint was reached and did not answer inside the bound. */
  | 'timeout'
  /** The app answered something other than 200. */
  | 'non-200'
  /** The app answered 200 with a body that is not `{ read, write }`. */
  | 'malformed'
  /** The authority could not sign the service-auth token at all. */
  | 'cannot-sign';

export type ManagingAppVerdict = Data.TaggedEnum<{
  Allow: {};
  Deny: {
    readonly reason: ManagingAppDenial;
    /** A sentence an operator can act on; it names the app and what happened. */
    readonly detail: string;
  };
}>;
export const ManagingAppVerdict = Data.taggedEnum<ManagingAppVerdict>();

/** The one way a managed check refuses. */
const denied = (reason: ManagingAppDenial, detail: string) =>
  ManagingAppVerdict.Deny({ reason, detail });

/** What the callback's output is, decoded at the boundary. Both fields are required. */
const ACCESS_ANSWER = Schema.Struct({
  read: Schema.Boolean,
  write: Schema.Boolean,
});

/**
 * The bound on the call: **two seconds**.
 *
 * It is the same bound the grant evaluator puts on a lookup
 * (`DEFAULT_ACCESS_TIMEOUT`) and the PDS puts on an outbound observer call, and
 * the reason is the same: this runs while a user's write is being held, so the
 * ceiling is "an app that is degraded but answering", not "an app that is
 * slow". A managing app with a slower backend is a managing app that should
 * cache its own answer; the spec makes a timeout a refusal, so waiting longer
 * cannot turn it into a yes — it only holds the write.
 */
export const MANAGING_APP_TIMEOUT = DEFAULT_ACCESS_TIMEOUT;

export interface AskManagingAppInput {
  /** The policy's `managingApp`: a DID with a fragment. */
  readonly managingApp: string;
  /** The space authority's DID: the service-auth issuer. */
  readonly authority: string;
  /** The space whose access is being checked, as the space ref this host uses. */
  readonly space: string;
  /** The user the decision is about. */
  readonly did: string;
  readonly access: ManagedAccess;
  /** The attested `client_id`, for reads. A write check never carries one. */
  readonly clientId?: string | undefined;
  /** The authority's signing key: `com.atproto.server.getServiceAuth` mints with it. */
  readonly signingKey: PrivateKey;
  readonly identity: IdentityResolver;
  readonly now: number;
}

const urlOf = (params: {
  readonly endpoint: string;
  readonly space: string;
  readonly did: string;
  readonly access: ManagedAccess;
  readonly clientId: string | undefined;
}) => {
  const base = params.endpoint.replace(/\/+$/, '');
  const url = new URL(`${base}/xrpc/${SPACE_METHODS.checkAccess}`);
  url.searchParams.set('space', params.space);
  url.searchParams.set('repo', params.did);
  // The proposal is explicit: a write carries no client, because `notifyWrite`
  // does not identify the app that originated it.
  if (params.access === 'read' && params.clientId !== undefined) {
    url.searchParams.set('clientId', params.clientId);
  }
  return url;
};

/**
 * Call the managing app and answer allow/deny.
 *
 * The service-auth token is minted here rather than asked for over HTTP: this
 * *is* the authority, and the token names the method as its `lxm`, so a token
 * minted for this call cannot be replayed against another one.
 */
export const askManagingApp = (params: AskManagingAppInput) =>
  Effect.gen(function* () {
    const resolved = yield* Effect.result(
      resolveServiceEndpoint({
        identifier: params.managingApp,
        resolver: params.identity,
      }),
    );
    if (Result.isFailure(resolved)) {
      return denied(
        'unresolvable',
        `${params.managingApp} could not be resolved to a service endpoint: ${resolved.failure.reason}`,
      );
    }
    const attempted = yield* Effect.result(
      Effect.try({
        try: () =>
          urlOf({
            endpoint: resolved.success.endpoint,
            space: params.space,
            did: params.did,
            access: params.access,
            clientId: params.clientId,
          }),
        catch: () => undefined,
      }),
    );
    if (Result.isFailure(attempted)) {
      return denied(
        'unresolvable',
        `${params.managingApp} names an endpoint that is not a URL: ${resolved.success.endpoint}`,
      );
    }
    const url = attempted.success;
    const token = yield* Effect.result(
      serviceAuthToken({
        key: params.signingKey,
        iss: params.authority,
        aud: params.managingApp,
        lxm: SPACE_METHODS.checkAccess,
        now: params.now,
      }),
    );
    if (Result.isFailure(token)) {
      return denied(
        'cannot-sign',
        `the authority could not sign the service-auth token: ${String(token.failure)}`,
      );
    }
    const signed = token.success;

    // The signal is ours so the socket is closed when the bound expires, and
    // aborted only once the body has been read: aborting as soon as the headers
    // arrive would kill the answer that has not been parsed yet.
    const controller = new AbortController();
    return yield* Effect.gen(function* () {
      const response = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            fetch(url, {
              signal: controller.signal,
              headers: { authorization: `Bearer ${signed}` },
            }),
          catch: (cause) => String(cause),
        }),
      );
      if (Result.isFailure(response)) {
        return denied(
          'unreachable',
          `the app could not be reached: ${response.failure}`,
        );
      }
      if (response.success.status !== 200) {
        return denied('non-200', `the app answered ${response.success.status}`);
      }
      // A body that is not JSON, and JSON that is not the shape, are both
      // "not the expected shape" - the app answered something, just not an
      // answer this host is allowed to read as one.
      const answer = yield* Effect.tryPromise({
        try: () => response.success.json(),
        catch: () => undefined,
      }).pipe(
        Effect.map((body) =>
          Option.getOrUndefined(
            Schema.decodeUnknownOption(ACCESS_ANSWER)(body),
          ),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      if (answer === undefined) {
        return denied(
          'malformed',
          'the app answered 200 with a body that is not { "read": boolean, "write": boolean }',
        );
      }
      return (params.access === 'read' ? answer.read : answer.write)
        ? ManagingAppVerdict.Allow()
        : denied(
            'the-app-denied',
            `the app said ${params.access} is false; its ${params.access === 'read' ? 'write' : 'read'} answer is a separate field and may differ`,
          );
    }).pipe(
      Effect.timeoutOrElse({
        duration: MANAGING_APP_TIMEOUT,
        orElse: () =>
          Effect.succeed(
            denied(
              'timeout',
              `the app never answered within ${Duration.toMillis(MANAGING_APP_TIMEOUT)} ms`,
            ),
          ),
      }),
      Effect.ensuring(Effect.sync(() => controller.abort())),
    );
  });
