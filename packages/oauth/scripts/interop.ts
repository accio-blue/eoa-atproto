/**
 * Interop: drive the client against a real atproto authorization server.
 *
 * The stub server in `client.test.ts` proves the client agrees with *us*. This proves
 * it agrees with a server we do not control: discovery, PKCE, the DPoP proof and the
 * pushed authorization request, all of which that server validates before it will hand
 * back a `request_uri`. It stops short of the token exchange, which needs a human to
 * approve the request in a browser.
 *
 * The configuration under test is the *plugin's*, read from its published metadata, so
 * the check cannot drift from what the plugin actually sends. Run it by hand, because
 * it needs the network and a `client_id` the server can fetch:
 *
 *     node_modules/.bin/tsx packages/oauth/scripts/interop.ts
 *     node_modules/.bin/tsx packages/oauth/scripts/interop.ts https://bsky.social alice.test
 *
 * It exits non-zero when it fails, so it can be used as a check. It sits outside
 * `src/`, so the package's typecheck does not cover it: running it is the check.
 */
import { Console, Effect, Schema } from 'effect';
import {
  type FetchLike,
  discoverAuthorizationServer,
  makeOAuthClient,
  memorySessionStore,
} from '@eoa/oauth';
import { fileURLToPath } from 'node:url';
import { generateES256KeyPair } from '@eoa/crypto';
import { readFileSync } from 'node:fs';

/** Reported when the interop check itself cannot proceed. */
class InteropError extends Schema.TaggedError<InteropError>()('InteropError', {
  message: Schema.String,
}) {}

const ClientMetadataSchema = Schema.Struct({
  client_id: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  scope: Schema.String,
});

const MetadataFromJson = Schema.fromJsonString(ClientMetadataSchema);

const pdsUrl = process.argv[2] ?? 'https://bsky.social';
const identifier = process.argv[3] ?? 'bsky.app';

const fetchLike: FetchLike = (request) => fetch(request.url, request.init);

/** The plugin's published metadata: the configuration actually being checked. */
const readMetadata = Effect.gen(function* () {
  const path = fileURLToPath(
    new URL(
      '../../../apps/obsidian-clipper/client-metadata.json',
      import.meta.url,
    ),
  );
  const text = yield* Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (cause) =>
      new InteropError({ message: `cannot read ${path}: ${String(cause)}` }),
  });
  return yield* Effect.fromOption(
    Schema.decodeUnknownOption(MetadataFromJson)(text),
    () => new InteropError({ message: `${path} is not client metadata` }),
  );
});

const program = Effect.gen(function* () {
  const metadata = yield* readMetadata;
  const clientId = process.env['INTEROP_CLIENT_ID'] ?? metadata.client_id;
  const redirectUri =
    process.env['INTEROP_REDIRECT_URI'] ?? metadata.redirect_uris[0]!;
  /**
   * The metadata's own scope, deliberately. atproto treats a request's scope as a
   * *narrowing* of what the client declared — asking for `transition:generic` from a
   * client that never declared it fails with `invalid_scope`, even though that scope
   * exists. `INTEROP_SCOPE` overrides, to probe exactly that.
   */
  const scope = process.env['INTEROP_SCOPE'] ?? metadata.scope;

  yield* Console.log(
    `interop: ${pdsUrl}, as ${identifier}, client ${clientId}`,
  );
  yield* Console.log(`  scope:       ${scope}`);

  // 1. discovery — bsky.social serves no protected-resource document, so this also
  //    exercises the fallback that treats the PDS as its own authorization server
  const server = yield* discoverAuthorizationServer({
    fetch: fetchLike,
    pdsUrl,
  });
  yield* Console.log(`  issuer:      ${server.issuer}`);
  yield* Console.log(`  authorize:   ${server.authorizationEndpoint}`);
  yield* Console.log(`  token:       ${server.tokenEndpoint}`);
  if (server.parEndpoint === undefined) {
    return yield* new InteropError({
      message: `${server.issuer} advertises no pushed authorization request endpoint`,
    });
  }
  yield* Console.log(`  par:         ${server.parEndpoint}`);

  // 2. PKCE + DPoP + PAR: the server verifies all three before issuing a request_uri
  const keyPair = yield* generateES256KeyPair();
  const client = makeOAuthClient({
    clientId,
    redirectUri,
    scope,
    key: keyPair.privateKey,
    fetch: fetchLike,
    sessions: memorySessionStore(),
  });
  const { url, state } = yield* client.createAuthorizationUrl({
    pdsUrl,
    identifier,
  });

  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () =>
      new InteropError({
        message: `the authorization URL is not a URL: ${url}`,
      }),
  });
  if (`${parsed.origin}${parsed.pathname}` !== server.authorizationEndpoint) {
    return yield* new InteropError({
      message: `the authorization URL is not the advertised endpoint: ${url}`,
    });
  }
  const requestUri = parsed.searchParams.get('request_uri');
  if (requestUri === null) {
    return yield* new InteropError({
      message: `the authorization URL carries no request_uri: ${url}`,
    });
  }

  yield* Console.log(`  state:       ${state}`);
  yield* Console.log(`  request_uri: ${requestUri}`);
  yield* Console.log(
    `interop: PASS (discovery + PKCE + DPoP + PAR against ${server.issuer})`,
  );
  yield* Console.log(
    '  not covered: the token exchange and a signed request need a human approval',
  );
});

const outcome = Effect.runPromise(
  program.pipe(
    Effect.tapError((cause) =>
      Console.error(`interop: FAIL - ${cause.message}`),
    ),
    Effect.orElseSucceed((): 'pass' | 'fail' => 'fail'),
  ),
);

const result = await outcome;
if (result === 'fail') {
  process.exitCode = 1;
}
