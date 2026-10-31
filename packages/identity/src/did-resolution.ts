import { Context, Effect, Layer, Schema } from 'effect';
import { type DIDDocument, type Service } from '@eoa/crypto';
import { DID } from '@eoa/core';
import { DIDNotFoundError } from './types.js';
import { PlcDidDocumentSchema } from './plc-operation.js';

/**
 * DID *document* resolution - as opposed to handle-to-DID, which is DNS.
 *
 * Two methods need the network here. `did:plc` documents are served by a PLC
 * directory — configurable, because ours serves the same shape, so pointing this
 * at `apps/directory` is how the mini-atmosphere resolves identities without an
 * edge to plc.directory. `did:web` documents are served by the domain the
 * identifier names, so they need no directory at all (W3C did:web).
 *
 * `did:key` documents are built from the identifier itself and never come
 * through here (see `@eoa/crypto`).
 */

/** Where `did:plc` documents are fetched from by default. */
export const DEFAULT_PLC_DIRECTORY_URL = 'https://plc.directory';

export class DidDocumentFetchError extends Schema.TaggedError<DidDocumentFetchError>()(
  'DidDocumentFetchError',
  {
    did: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export interface DidDocumentTransportShape {
  /** The document body, or undefined when the directory does not know the DID. */
  readonly fetchDocument: (
    did: string,
  ) => Effect.Effect<string | undefined, DidDocumentFetchError>;
}

export class DidDocumentTransport extends Context.Service<
  DidDocumentTransport,
  DidDocumentTransportShape
>()('@eoa/identity/DidDocumentTransport') {}

/**
 * The URL a `did:web` document is served at (W3C did:web): the host from the
 * method-specific id, then either `/.well-known/did.json` or the remaining
 * segments as a path. A port is percent-encoded in the identifier
 * (`did:web:example.com%3A8443`), which is why the host is decoded.
 *
 * `undefined` when the id cannot name an https URL at all — a `did:web` with no
 * host, or one carrying something that is not a hostname. The caller turns that
 * into "no document", which is what a resolver may conclude.
 */
export const didWebUrl = (did: string): string | undefined => {
  if (!did.startsWith('did:web:')) return undefined;
  const [hostSegment, ...segments] = did.slice('did:web:'.length).split(':');
  if (hostSegment === undefined || hostSegment === '') return undefined;
  if (segments.some((segment) => segment === '')) return undefined;
  let host: string;
  try {
    host = decodeURIComponent(hostSegment);
  } catch {
    return undefined;
  }
  // A host, optionally with a port. No scheme, no slash: the URL is https, always.
  if (!/^[A-Za-z0-9.-]+(:[0-9]+)?$/.test(host)) return undefined;
  const path =
    segments.length === 0
      ? '.well-known/did.json'
      : `${segments.join('/')}/did.json`;
  return `https://${host}/${path}`;
};

/** Where a DID's document lives: the directory for `did:plc`, the domain for `did:web`. */
const documentUrlOf = (directoryUrl: string, did: string) =>
  didMethod(did) === 'web' ? didWebUrl(did) : `${directoryUrl}/${did}`;

export const makeDidDocumentTransport = (directoryUrl: string) => ({
  fetchDocument: (
    did: string,
  ): Effect.Effect<string | undefined, DidDocumentFetchError> => {
    const url = documentUrlOf(directoryUrl, did);
    if (url === undefined) return Effect.succeed(undefined);
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(url);
        return response.ok ? await response.text() : undefined;
      },
      catch: (cause) =>
        new DidDocumentFetchError({
          did,
          reason: 'fetch',
          message: `fetching ${did} from ${url} failed: ${String(cause)}`,
        }),
    });
  },
});

/** The live transport, pointed at plc.directory. */
export const liveDidDocumentTransport = makeDidDocumentTransport(
  DEFAULT_PLC_DIRECTORY_URL,
);

export const didDocumentTransportLayer = (
  directoryUrl: string = DEFAULT_PLC_DIRECTORY_URL,
) =>
  Layer.succeed(DidDocumentTransport, makeDidDocumentTransport(directoryUrl));

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The DID method: `plc` in `did:plc:…`. */
export const didMethod = (did: string) => did.split(':')[1];

const PlcDocument = Schema.fromJsonString(PlcDidDocumentSchema);

/**
 * A `did:plc` document, fetched and decoded. Nothing from the network is
 * trusted: the body is parsed by the schema the directory renders, so a
 * document that does not match is a resolution failure rather than a partial
 * identity.
 */
export const resolvePlcDocument = (did: string) =>
  Effect.gen(function* () {
    const transport = yield* DidDocumentTransport;
    const body = yield* transport.fetchDocument(did);
    if (body === undefined) {
      return yield* new DIDNotFoundError({ identifier: did });
    }
    return yield* Schema.decodeEffect(PlcDocument)(body).pipe(
      Effect.mapError(() => new DIDNotFoundError({ identifier: did })),
    );
  }).pipe(
    Effect.withSpan('identity.resolvePlcDocument', {
      attributes: { 'identity.did': did },
    }),
  );

/**
 * The parts of a `did:web` document a resolver uses. A field this schema does
 * not name is dropped rather than rejected: a did:web document is somebody
 * else's JSON, and being strict about fields we ignore would turn a usable
 * document into a resolution failure.
 */
const WebDocument = Schema.fromJsonString(
  Schema.Struct({
    id: DID,
    alsoKnownAs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    service: Schema.optional(
      Schema.mutable(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            type: Schema.String,
            serviceEndpoint: Schema.Json,
          }),
        ),
      ),
    ),
    verificationMethod: Schema.optional(
      Schema.mutable(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            type: Schema.String,
            controller: DID,
            publicKeyMultibase: Schema.optional(Schema.String),
          }),
        ),
      ),
    ),
  }),
);

/**
 * A `did:web` document, fetched from the URL its own identifier names and
 * decoded like a `did:plc` one: a document that does not parse is a resolution
 * failure, not a half-identity. It needs no directory, which is what makes a
 * `did:web` managing app reachable from a host that has no PLC configuration.
 */
export const resolveWebDocument = (did: string) =>
  Effect.gen(function* () {
    const transport = yield* DidDocumentTransport;
    const body = yield* transport.fetchDocument(did);
    if (body === undefined) {
      return yield* new DIDNotFoundError({ identifier: did });
    }
    const decoded = yield* Schema.decodeEffect(WebDocument)(body).pipe(
      Effect.mapError(() => new DIDNotFoundError({ identifier: did })),
    );
    // A did:web document is served by whoever controls the domain, not by a directory: one that names
    // a different DID is that host's document, and this DID must not inherit its services.
    if (decoded.id !== did) {
      return yield* new DIDNotFoundError({ identifier: did });
    }
    // Spelled out rather than spread: `exactOptionalPropertyTypes` will not let an optional field
    // that is present-but-undefined through, and a document type's optional fields are absent.
    return {
      id: decoded.id,
      ...(decoded.alsoKnownAs === undefined
        ? {}
        : { alsoKnownAs: decoded.alsoKnownAs }),
      ...(decoded.service === undefined ? {} : { service: decoded.service }),
      // Required by the document type, optional in the JSON; a method with no key is still a method.
      verificationMethod: (decoded.verificationMethod ?? []).map((method) => ({
        id: method.id,
        type: method.type,
        controller: method.controller,
        ...(method.publicKeyMultibase === undefined
          ? {}
          : { publicKeyMultibase: method.publicKeyMultibase }),
      })),
    } satisfies DIDDocument;
  }).pipe(
    Effect.withSpan('identity.resolveWebDocument', {
      attributes: { 'identity.did': did },
    }),
  );

/** The `#atproto_pds` endpoint, when the document advertises one. */
export const pdsEndpointOf = (services: readonly Service[]) => {
  const pds = services.find(
    (service) =>
      service.id === '#atproto_pds' || service.id.endsWith('#atproto_pds'),
  );
  return typeof pds?.serviceEndpoint === 'string'
    ? pds.serviceEndpoint
    : undefined;
};

/** A document claims its handles through `alsoKnownAs: ['at://<handle>']`. */
export const handleFromAlsoKnownAs = (alsoKnownAs: readonly string[]) => {
  const claim = alsoKnownAs.find((value) => value.startsWith('at://'));
  return claim?.slice('at://'.length);
};
