import { Effect, Match, Option, Schema } from 'effect';
import { type IdentityErrorUnion, type IdentityResolver } from './types.js';
import { DID } from '@eoa/core';
import { type Service } from '@eoa/crypto';

/**
 * A **service identifier** — a DID with a fragment, e.g.
 * `did:web:forum.example#forum` — resolved to the endpoint it names.
 *
 * The fragment is what a DID document's `service` entries are keyed by, so the
 * lookup is over the document the DID resolves to, never a URL joined by hand:
 * a DID may advertise the service on a host that is not the DID's own, and only
 * the document says where.
 */

/** A service identifier that cannot be resolved to an endpoint, and why. */
export class ServiceNotFoundError extends Schema.TaggedError<ServiceNotFoundError>()(
  'ServiceNotFoundError',
  {
    identifier: Schema.String,
    reason: Schema.String,
  },
) {}

/** The endpoint a document advertises for `#fragment` (`did#fragment` is also accepted). */
export const serviceEndpointOf = (params: {
  readonly did: string;
  readonly fragment: string;
  readonly services: readonly Service[];
}) => {
  const named = params.services.find(
    (service) =>
      service.id === `#${params.fragment}` ||
      service.id === `${params.did}#${params.fragment}`,
  );
  return typeof named?.serviceEndpoint === 'string'
    ? named.serviceEndpoint
    : undefined;
};

/** The split of a service identifier into the DID and the fragment. */
const partsOf = (identifier: string) => {
  const at = identifier.lastIndexOf('#');
  return at <= 0 || at === identifier.length - 1
    ? undefined
    : {
        did: identifier.slice(0, at),
        fragment: identifier.slice(at + 1),
      };
};

export interface ServiceEndpoint {
  /** The identifier as given, so a caller can name what it asked about. */
  readonly identifier: string;
  readonly did: DID;
  readonly fragment: string;
  readonly endpoint: string;
}

/** The identity failures a service lookup can hit, said as one sentence each. */
const reasonOf = (params: {
  readonly identifier: string;
  readonly error: IdentityErrorUnion;
}) =>
  Match.value(params.error).pipe(
    Match.tag(
      'DIDNotFoundError',
      () => `no DID document names ${params.identifier}`,
    ),
    Match.tag(
      'IdentityError',
      () => `the DID document for ${params.identifier} could not be read`,
    ),
    Match.tag(
      'HandleNotFoundError',
      () => `${params.identifier} is not a known handle`,
    ),
    Match.tag(
      'InvalidIdentifierError',
      () => `${params.identifier} is not an identifier`,
    ),
    Match.exhaustive,
  );

/**
 * Resolve `did#fragment` to its endpoint. A resolver is passed rather than
 * defaulted: this package's default resolver has no way to be pointed at a
 * test directory, and a caller that already holds one should have it used.
 */
export const resolveServiceEndpoint = (params: {
  readonly identifier: string;
  readonly resolver: IdentityResolver;
}) =>
  Effect.gen(function* () {
    const parts = partsOf(params.identifier);
    if (parts === undefined) {
      return yield* new ServiceNotFoundError({
        identifier: params.identifier,
        reason:
          'a service identifier is a DID and a #fragment, as in did:web:example.com#forum',
      });
    }
    const did = Schema.decodeUnknownOption(DID)(parts.did);
    if (Option.isNone(did)) {
      return yield* new ServiceNotFoundError({
        identifier: params.identifier,
        reason: `${parts.did} is not a DID`,
      });
    }
    const resolution = yield* params.resolver.resolveDID(did.value).pipe(
      Effect.mapError(
        (error) =>
          new ServiceNotFoundError({
            identifier: params.identifier,
            reason: reasonOf({
              identifier: params.identifier,
              error,
            }),
          }),
      ),
    );
    const services =
      resolution.services ?? resolution.didDocument.service ?? [];
    const endpoint = serviceEndpointOf({
      did: did.value,
      fragment: parts.fragment,
      services,
    });
    if (endpoint === undefined) {
      return yield* new ServiceNotFoundError({
        identifier: params.identifier,
        reason: `the DID document advertises no #${parts.fragment} service`,
      });
    }
    return {
      identifier: params.identifier,
      did: did.value,
      fragment: parts.fragment,
      endpoint,
    };
  });
