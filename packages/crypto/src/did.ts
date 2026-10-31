import {
  CryptoError,
  DID,
  PublicKey,
  exportPublicKey,
  importP256PublicKeyFromPoint,
} from './keys.js';
import { Effect, Schema } from 'effect';
import { base64urlDecode, base64urlEncode, sha256 } from './signing.js';
import {
  formatDidKeyFromCoordinates,
  importablePointFromDidKey,
} from './p256.js';

// DID Key thumbprint computation (RFC 7638)
export const computeThumbprint = (
  publicKey: PublicKey,
): Effect.Effect<string, CryptoError> =>
  Effect.gen(function* () {
    const jwk = yield* exportPublicKey(publicKey);

    // Create the thumbprint input according to RFC 7638
    const thumbprintInput = {
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
      y: jwk.y,
    };

    const jsonInput = JSON.stringify(thumbprintInput);
    const hash = yield* sha256(new TextEncoder().encode(jsonInput));

    return base64urlEncode(hash);
  });

// Create a DID:key from a public key
export const createDIDKey = (
  publicKey: PublicKey,
): Effect.Effect<DID, CryptoError> =>
  Effect.gen(function* () {
    const jwk = yield* exportPublicKey(publicKey);

    if (jwk.x === undefined || jwk.y === undefined) {
      return yield* Effect.fail(
        new CryptoError({
          cause: new Error('public JWK is missing its x/y coordinates'),
          operation: 'didKeyCreation',
        }),
      );
    }

    // did:key is base58btc multibase over the multicodec-prefixed COMPRESSED
    // point - not a thumbprint, which is a different encoding entirely.
    const did = yield* formatDidKeyFromCoordinates({
      x: base64urlDecode(jwk.x),
      y: base64urlDecode(jwk.y),
    });

    return Schema.decodeSync(DID)(did);
  });

// Extract public key from DID:key
export const extractPublicKeyFromDID = (did: DID) =>
  Effect.gen(function* () {
    const point = yield* importablePointFromDidKey(did);
    return yield* importP256PublicKeyFromPoint(point);
  });

// Verify DID matches public key
export const verifyDIDKey = (
  did: DID,
  publicKey: PublicKey,
): Effect.Effect<boolean, CryptoError> =>
  Effect.gen(function* () {
    const expectedDID = yield* createDIDKey(publicKey);
    return expectedDID === did;
  });

/**
 * A service endpoint: a URL in practice, but the DID spec allows any JSON value
 * and a resolver should not reject a document for using one.
 */
export type ServiceEndpointValue =
  | string
  | number
  | boolean
  | null
  | readonly ServiceEndpointValue[]
  | { readonly [key: string]: ServiceEndpointValue };

/** A service the document advertises - for atproto, `#atproto_pds`. */
export interface Service {
  readonly id: string;
  readonly type: string;
  readonly serviceEndpoint: ServiceEndpointValue;
}

// DID document interface
export interface DIDDocument {
  /** The JSON-LD contexts the document's terms are defined in. */
  readonly '@context'?: readonly string[];
  readonly id: DID;
  readonly verificationMethod: readonly VerificationMethod[];
  /** The handles the identity claims, written as `at://<handle>`. */
  readonly alsoKnownAs?: readonly string[];
  /** Advertised services. Without a `#atproto_pds` one there is no PDS. */
  readonly service?: readonly Service[];
  readonly authentication?: readonly string[];
  readonly assertionMethod?: readonly string[];
}

export interface VerificationMethod {
  readonly id: string;
  readonly type: string;
  readonly controller: DID;
  readonly publicKeyJwk?: JsonWebKey;
  /**
   * The key as a multibase string, which is how a document written for atproto carries it:
   * `Multikey` and the `did:key`'s own encoding rather than a JWK, because a client verifying
   * repos uses the same key the server signs with.
   */
  readonly publicKeyMultibase?: string;
}

// Create a DID document from a public key
export const createDIDDocument = (
  publicKey: PublicKey,
): Effect.Effect<DIDDocument, CryptoError> =>
  Effect.gen(function* () {
    const did = yield* createDIDKey(publicKey);
    const jwk = yield* exportPublicKey(publicKey);

    const verificationMethod: VerificationMethod = {
      id: `${did}#key-1`,
      type: 'JsonWebKey2020',
      controller: did,
      publicKeyJwk: jwk,
    };

    return {
      id: did,
      verificationMethod: [verificationMethod],
      authentication: [`${did}#key-1`],
      assertionMethod: [`${did}#key-1`],
    };
  });

/**
 * The DID documents a resolver can build without the network. Only `did:key`
 * qualifies: every other method needs a directory, which lives in
 * `@eoa/identity` (its `did:plc` path fetches and validates one).
 */
export const resolveDIDDocument = (
  did: DID,
): Effect.Effect<DIDDocument, CryptoError> =>
  Effect.gen(function* () {
    // For DID:key, we can construct the document locally
    if (did.startsWith('did:key:')) {
      const publicKey = yield* extractPublicKeyFromDID(did);
      return yield* createDIDDocument(publicKey);
    }

    // For other DID methods, would need external resolver
    return yield* Effect.fail(
      new CryptoError({
        cause: new Error('DID method not supported'),
        operation: 'didResolution',
      }),
    );
  });
