import { DID, Handle } from '@eoa/core';
import { type DIDDocument, type Service } from '@eoa/crypto';
import { Data, Effect } from 'effect';

// Identity resolution result
export interface IdentityResolution {
  readonly did: DID;
  readonly handle?: Handle;
  readonly didDocument: DIDDocument;
  readonly alsoKnownAs?: readonly string[];
  readonly services?: readonly Service[];
  /** The `#atproto_pds` endpoint, when the document advertises one. */
  readonly pds?: string;
}

// Handle resolution result
export interface HandleResolution {
  readonly handle: Handle;
  readonly did: DID;
  readonly alsoKnownAs?: readonly string[];
}

// Identity error union type
export type IdentityErrorUnion =
  | IdentityError
  | DIDNotFoundError
  | HandleNotFoundError
  | InvalidIdentifierError;

// Identity resolver interface
export interface IdentityResolver {
  readonly resolveDID: (
    did: DID,
  ) => Effect.Effect<IdentityResolution, IdentityErrorUnion>;
  readonly resolveHandle: (
    handle: Handle,
  ) => Effect.Effect<HandleResolution, IdentityErrorUnion>;
  readonly resolveIdentity: (
    identifier: DID | Handle,
  ) => Effect.Effect<IdentityResolution, IdentityErrorUnion>;
}

// Identity error types
export class IdentityError extends Data.TaggedError('IdentityError')<{
  readonly cause: unknown;
  readonly operation:
    | 'didResolution'
    | 'handleResolution'
    | 'identityResolution';
  readonly identifier: string;
}> {}

export class DIDNotFoundError extends Data.TaggedError('DIDNotFoundError')<{
  readonly identifier: string;
}> {}

export class HandleNotFoundError extends Data.TaggedError(
  'HandleNotFoundError',
)<{
  readonly identifier: string;
}> {}

export class InvalidIdentifierError extends Data.TaggedError(
  'InvalidIdentifierError',
)<{
  readonly identifier: string;
}> {}

// Cache entry for identity resolution
export interface IdentityCacheEntry {
  readonly resolution: IdentityResolution;
  readonly timestamp: number;
  readonly ttl: number;
}

// Handle to DID mapping cache entry
export interface HandleCacheEntry {
  readonly did: DID;
  readonly timestamp: number;
  readonly ttl: number;
}
