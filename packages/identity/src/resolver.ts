import { DID, Handle } from '@eoa/core';
import { type DIDDocument, resolveDIDDocument } from '@eoa/crypto';
import {
  DIDNotFoundError,
  HandleNotFoundError,
  HandleResolution,
  IdentityError,
  IdentityErrorUnion,
  IdentityResolution,
  IdentityResolver,
  InvalidIdentifierError,
} from './types.js';
import {
  type DidDocumentFetchError,
  DidDocumentTransport,
  type DidDocumentTransportShape,
  didMethod,
  handleFromAlsoKnownAs,
  liveDidDocumentTransport,
  pdsEndpointOf,
  resolvePlcDocument,
  resolveWebDocument,
} from './did-resolution.js';
import { Effect, Match, Option, Schema } from 'effect';
import {
  HandleTransport,
  type HandleTransportShape,
  liveHandleTransport,
  resolveHandleFromNetwork,
} from './handle-resolution.js';

const resolveHandleThenDid = (params: {
  readonly resolver: IdentityResolver;
  readonly identifier: Handle;
}) =>
  Effect.gen(function* () {
    const handleResolution = yield* params.resolver.resolveHandle(
      params.identifier,
    );
    return yield* params.resolver.resolveDID(handleResolution.did);
  });

/** A handle claim is kept only when it is syntactically a handle. */
const decodeHandle = (value: string) =>
  Option.getOrUndefined(Schema.decodeOption(Handle)(value));

/** Derive the handle, the services and the PDS endpoint a document implies. */
const toResolution = (params: {
  readonly did: DID;
  readonly document: DIDDocument;
  readonly handle?: Handle;
}) => {
  const alsoKnownAs = params.document.alsoKnownAs ?? [];
  const services = params.document.service ?? [];
  const claimed = handleFromAlsoKnownAs(alsoKnownAs);
  const handle =
    params.handle ??
    (claimed === undefined ? undefined : decodeHandle(claimed));
  const pds = pdsEndpointOf(services);

  return {
    did: params.did,
    didDocument: params.document,
    alsoKnownAs,
    services,
    ...(handle === undefined ? {} : { handle }),
    ...(pds === undefined ? {} : { pds }),
  } satisfies IdentityResolution;
};

// Default identity resolver implementation
export class DefaultIdentityResolver implements IdentityResolver {
  constructor(
    private readonly handleTransport: HandleTransportShape = liveHandleTransport,
    private readonly didTransport: DidDocumentTransportShape = liveDidDocumentTransport,
  ) {}

  resolveDID(did: DID): Effect.Effect<IdentityResolution, IdentityErrorUnion> {
    const didTransport = this.didTransport;
    return Effect.gen(function* () {
      // A did:plc document is served by a directory, a did:web one by the domain
      // the identifier names, and a did:key document is built from the identifier
      // itself - so only the first two need a transport.
      const fromNetwork = (
        resolve: Effect.Effect<
          DIDDocument,
          DIDNotFoundError | DidDocumentFetchError,
          DidDocumentTransport
        >,
      ) =>
        resolve.pipe(
          Effect.provideService(DidDocumentTransport, didTransport),
          // A host that cannot be reached is a resolution failure, not a
          // missing identity - the cause says which. A 404 stays a
          // DIDNotFoundError, which is the difference that matters.
          Effect.catchTag('DidDocumentFetchError', (error) =>
            Effect.fail(
              new IdentityError({
                cause: error,
                operation: 'didResolution',
                identifier: did,
              }),
            ),
          ),
        );

      const document = yield* Match.value(didMethod(did)).pipe(
        Match.when('plc', () => fromNetwork(resolvePlcDocument(did))),
        Match.when('web', () => fromNetwork(resolveWebDocument(did))),
        Match.orElse(() =>
          resolveDIDDocument(did).pipe(
            Effect.mapError(() => new DIDNotFoundError({ identifier: did })),
          ),
        ),
      );

      return toResolution({ did, document });
    }).pipe(
      Effect.catchIf(
        (error) => !(error instanceof IdentityError),
        () => new DIDNotFoundError({ identifier: did }),
      ),
    );
  }

  resolveHandle(
    handle: Handle,
  ): Effect.Effect<HandleResolution, IdentityErrorUnion> {
    // A syntactically impossible handle cannot be a DNS name, so reject it
    // before doing any network work.
    if (!handle.includes('.')) {
      return Effect.fail(new InvalidIdentifierError({ identifier: handle }));
    }

    return resolveHandleFromNetwork(handle).pipe(
      Effect.provideService(HandleTransport, this.handleTransport),
      Effect.map((did) => ({ handle, did })),
      Effect.mapError((error) =>
        error instanceof HandleNotFoundError
          ? error
          : new IdentityError({
              cause: error,
              operation: 'handleResolution',
              identifier: handle,
            }),
      ),
    );
  }

  resolveIdentity(
    identifier: DID | Handle,
  ): Effect.Effect<IdentityResolution, IdentityErrorUnion> {
    // Determine if identifier is a DID or handle
    if (identifier.startsWith('did:')) {
      return this.resolveDID(identifier as DID);
    } else if (identifier.includes('.')) {
      // Resolve the handle first, then its DID - and keep the handle the caller
      // asked about, which is what an actor is addressed by.
      const handle = decodeHandle(identifier);
      if (handle === undefined) {
        return Effect.fail(new InvalidIdentifierError({ identifier }));
      }

      return resolveHandleThenDid({ resolver: this, identifier: handle }).pipe(
        Effect.map((resolution) => ({ ...resolution, handle })),
      );
    } else {
      return Effect.fail(new InvalidIdentifierError({ identifier }));
    }
  }
}

// Create default resolver instance
export const defaultResolver = new DefaultIdentityResolver();

// Convenience functions using default resolver
export const resolveDID = (
  did: DID,
): Effect.Effect<IdentityResolution, IdentityErrorUnion> =>
  defaultResolver.resolveDID(did);

export const resolveHandle = (
  handle: Handle,
): Effect.Effect<HandleResolution, IdentityErrorUnion> =>
  defaultResolver.resolveHandle(handle);

export const resolveIdentity = (
  identifier: DID | Handle,
): Effect.Effect<IdentityResolution, IdentityErrorUnion> =>
  defaultResolver.resolveIdentity(identifier);
