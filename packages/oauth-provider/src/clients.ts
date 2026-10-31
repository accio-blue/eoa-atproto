import { Effect, Schema } from 'effect';
import type { FetchLike } from '@eoa/oauth';

/**
 * Client metadata, and where it comes from.
 *
 * atproto clients identify themselves with a URL — their metadata document *is*
 * their identity — so the provider fetches that document and believes what is in
 * it and nothing else. A client whose `client_id` does not name itself is not that
 * client, which is why this check is here and not in the caller.
 */

/** Reported when a client cannot be established. */
export class ClientError extends Schema.TaggedError<ClientError>()(
  'ClientError',
  {
    message: Schema.String,
  },
) {}

/** What the provider needs to know about a client. */
export interface ClientMetadata {
  readonly clientId: string;
  readonly redirectUris: ReadonlyArray<string>;
  /** The scope the client declared, which a request may only narrow. */
  readonly scope: string | undefined;
}

/**
 * The atproto loopback exception: a native app names itself
 * `http://localhost?redirect_uri=…&scope=…` instead of publishing a document.
 * The authorization server synthesises the metadata from the query — there is
 * nothing to fetch, and `localhost` is not reachable from the server anyway.
 *
 * Returns `undefined` for anything that is not a loopback client id (including
 * `http://localhost:1234`, a path, HTTPS, another host). The caller then falls
 * back to fetching the document.
 */
export const loopbackClientMetadata = (clientId: string) => {
  if (!URL.canParse(clientId)) {
    return undefined;
  }
  const url = new URL(clientId);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'localhost' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  const redirectUri = url.searchParams.get('redirect_uri');
  const scope = url.searchParams.get('scope');
  if (redirectUri === null || !URL.canParse(redirectUri)) {
    return undefined;
  }
  if (scope === null || !scope.split(/\s+/).includes('atproto')) {
    return undefined;
  }
  return { clientId, redirectUris: [redirectUri], scope };
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isLoopbackRedirect = (url: URL) =>
  url.protocol === 'http:' &&
  url.port !== '' &&
  LOOPBACK_HOSTS.has(url.hostname);

/**
 * Whether a requested `redirect_uri` belongs to a registered one. A native app
 * binds a free port per login, so loopback redirects match on protocol, host,
 * path and query, ignoring the port. Everything else must be exact.
 */
export const redirectUriMatches = (registered: string, requested: string) => {
  if (registered === requested) {
    return true;
  }
  if (!URL.canParse(registered) || !URL.canParse(requested)) {
    return false;
  }
  const a = new URL(registered);
  const b = new URL(requested);
  return (
    isLoopbackRedirect(a) &&
    isLoopbackRedirect(b) &&
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
};

/** Where a client's metadata is read from. */
export interface ClientMetadataSource {
  readonly get: (
    clientId: string,
  ) => Effect.Effect<ClientMetadata, ClientError>;
}

const ClientMetadataSchema = Schema.Struct({
  client_id: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  scope: Schema.optionalKey(Schema.String),
});

/** Read client metadata from the `client_id` URL, as atproto clients publish it. */
export const httpClientMetadata = (fetch: FetchLike) => ({
  get: (clientId: string) =>
    Effect.gen(function* () {
      const loopback = loopbackClientMetadata(clientId);
      if (loopback !== undefined) {
        return loopback;
      }
      if (!URL.canParse(clientId)) {
        return yield* new ClientError({ message: `${clientId} is not a URL` });
      }

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch({
            url: clientId,
            init: { method: 'GET', headers: { accept: 'application/json' } },
          }),
        catch: (cause) =>
          new ClientError({
            message: `could not fetch ${clientId}: ${String(cause)}`,
          }),
      });
      if (response.status !== 200) {
        return yield* new ClientError({
          message: `${clientId} answered ${response.status}`,
        });
      }

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new ClientError({
            message: `could not read ${clientId}: ${String(cause)}`,
          }),
      });
      const metadata = yield* Effect.fromOption(
        Schema.decodeOption(Schema.fromJsonString(ClientMetadataSchema))(text),
        () =>
          new ClientError({ message: `${clientId} is not client metadata` }),
      );
      if (metadata.client_id !== clientId) {
        return yield* new ClientError({
          message: `the metadata at ${clientId} names ${metadata.client_id}`,
        });
      }

      return {
        clientId,
        redirectUris: metadata.redirect_uris,
        scope: metadata.scope,
      };
    }),
});
