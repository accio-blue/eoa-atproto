import { Effect, Option, Schema } from 'effect';
import { type FetchLike, jsonDecoded, responseText, send } from './http.js';

/**
 * Discovery, per the atproto OAuth profile: a PDS publishes
 * `/.well-known/oauth-protected-resource` naming the authorization server(s) it
 * accepts, and that server publishes
 * `/.well-known/oauth-authorization-server` with the endpoints.
 *
 * A PDS that publishes nothing is treated as its own authorization server
 * (Tier 0.2's "the PDS acts as OAuth issuer"), which is also the only sane
 * fallback: refusing to try would make a self-issued deployment unusable.
 */

/** Reported when the endpoints cannot be established. */
export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()(
  'DiscoveryError',
  { message: Schema.String },
) {}

const ProtectedResourceSchema = Schema.Struct({
  authorization_servers: Schema.optionalKey(Schema.Array(Schema.String)),
});

const AuthorizationServerSchema = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  pushed_authorization_request_endpoint: Schema.optionalKey(Schema.String),
  revocation_endpoint: Schema.optionalKey(Schema.String),
});

/** The endpoints a client needs, in the names it will use them by. */
export interface AuthorizationServer {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly parEndpoint?: string;
  readonly revocationEndpoint?: string;
}

const wellKnown = (params: {
  readonly base: string;
  readonly path: string;
}): string => new URL(params.path, params.base).toString();

/** The issuers a PDS points at, or the PDS itself when it points at nobody. */
const authorizationServers = (params: {
  readonly fetch: FetchLike;
  readonly pdsUrl: string;
}): Effect.Effect<readonly string[], never> =>
  Effect.gen(function* () {
    const response = yield* send({
      fetch: params.fetch,
      url: wellKnown({
        base: params.pdsUrl,
        path: '/.well-known/oauth-protected-resource',
      }),
      method: 'GET',
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (response === undefined || response.status !== 200) {
      return [params.pdsUrl];
    }

    const text = yield* responseText(response).pipe(
      Effect.orElseSucceed(() => ''),
    );
    const decoded = jsonDecoded({
      schema: ProtectedResourceSchema,
      text,
    });
    if (Option.isNone(decoded)) {
      return [params.pdsUrl];
    }

    const listed = decoded.value.authorization_servers;
    return listed === undefined || listed.length === 0
      ? [params.pdsUrl]
      : listed;
  });

/** The authorization server a PDS points at, with its endpoints read. */
export const discoverAuthorizationServer = (params: {
  readonly fetch: FetchLike;
  readonly pdsUrl: string;
}): Effect.Effect<AuthorizationServer, DiscoveryError> =>
  Effect.gen(function* () {
    const issuers = yield* authorizationServers(params);
    const issuer = issuers[0];
    if (issuer === undefined) {
      return yield* new DiscoveryError({
        message: `no authorization server is advertised by ${params.pdsUrl}`,
      });
    }

    const metadataUrl = wellKnown({
      base: issuer,
      path: '/.well-known/oauth-authorization-server',
    });
    const response = yield* send({
      fetch: params.fetch,
      url: metadataUrl,
      method: 'GET',
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (response === undefined) {
      return yield* new DiscoveryError({
        message: `could not reach ${issuer} for its metadata`,
      });
    }
    if (response.status !== 200) {
      return yield* new DiscoveryError({
        message: `${issuer} answered ${response.status} for ${metadataUrl}`,
      });
    }

    const text = yield* responseText(response).pipe(
      Effect.orElseSucceed(() => ''),
    );
    const decoded = jsonDecoded({
      schema: AuthorizationServerSchema,
      text,
    });
    if (Option.isNone(decoded)) {
      return yield* new DiscoveryError({
        message: `${issuer} did not return an authorization server document`,
      });
    }

    const metadata = decoded.value;
    return {
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      ...(metadata.pushed_authorization_request_endpoint === undefined
        ? {}
        : { parEndpoint: metadata.pushed_authorization_request_endpoint }),
      ...(metadata.revocation_endpoint === undefined
        ? {}
        : { revocationEndpoint: metadata.revocation_endpoint }),
    };
  });
