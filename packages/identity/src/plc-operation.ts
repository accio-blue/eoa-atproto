import {
  CODEC_DAG_CBOR,
  DID,
  cidFromDigest,
  encodeBase32,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import { Effect, Result, Schema, Struct } from 'effect';
import {
  type PrivateKey,
  type Secp256k1Key,
  base64urlDecode,
  base64urlEncode,
  importP256PublicKeyFromPoint,
  importablePointFromDidKey,
  parseP256DidKey,
  parseSecp256k1DidKey,
  sha256,
  sign,
  signSecp256k1,
  verify,
  verifySecp256k1,
} from '@eoa/crypto';

/**
 * The PLC v0.3.0 operation model: build, sign, validate, derive, render.
 *
 * This is the did:plc method verbatim (see docs/plans/tier0-1-directory.md),
 * because a did:plc **is** the hash of its genesis operation. A genesis op that
 * is not byte-valid names a different identifier when a directory replays it,
 * and the DID can then never be preserved - so compatibility is decided when
 * the first op is minted, not at migration time.
 *
 * Every rule below was checked against the live directory rather than only the
 * spec text:
 *
 * - the DID and the `prev` CID are both `sha256(dag-cbor(SIGNED op))`;
 * - a signature covers `dag-cbor(op with `sig` OMITTED)` - a different byte
 *   string from the one the CID hashes, and the easiest thing to conflate;
 * - signatures are raw `r||s`, base64url, unpadded, low-S (400/400 sampled
 *   real operations were low-S, so our strict check matches the network);
 * - `prev` is a CID *string*, never a binary IPLD link.
 *
 * The op types are `type` aliases with mutable arrays, not Schema-derived
 * types: an operation must be assignable to the DAG-CBOR encoder's `CborValue`
 * index signature, which `readonly T[]` is not. Decoding *untrusted* input with
 * Schema belongs at the HTTP boundary (M4), where such input first appears.
 */

/** PLC's service type for an atproto PDS. */
export const PDS_SERVICE_TYPE = 'AtprotoPersonalDataServer';

/** `did:key:` - the prefix stripped to get a Multikey's `publicKeyMultibase`. */
const DID_KEY_PREFIX = 'did:key:';

/** A did:plc keeps 24 base32 characters of the genesis hash - 15 bytes exactly. */
const DID_SUFFIX_LENGTH = 24;

const MAX_ROTATION_KEYS = 5;
const SIGNATURE_BYTES = 64;

/** Reported when an operation is not a well-formed PLC operation. */
export class InvalidPlcOperationError extends Schema.TaggedError<InvalidPlcOperationError>()(
  'InvalidPlcOperationError',
  {
    message: Schema.String,
  },
) {}

/** Reported when an operation is not authorized by the keys it claims. */
export class InvalidPlcSignatureError extends Schema.TaggedError<InvalidPlcSignatureError>()(
  'InvalidPlcSignatureError',
  {
    message: Schema.String,
  },
) {}

/** Expected failures of the operation model. */
export type PlcError = InvalidPlcOperationError | InvalidPlcSignatureError;

/**
 * The shape of a `plc_operation`, defined once as a schema: the same value is
 * decoded from an HTTP submission (untrusted), encoded as canonical DAG-CBOR,
 * and served back as JSON.
 *
 * The arrays are `Schema.mutable` on purpose - the DAG-CBOR encoder's
 * `CborValue` index signature does not accept `readonly T[]`.
 *
 * `sig` is absent only while the operation is being built: the signature
 * covers these six fields and nothing else.
 */
/**
 * The verification methods an operation names: `atproto` signs, and
 * `atproto_kem` is the dedicated key a space repo's shared secret is agreed
 * against (spaces alpha, 2026-10-22, section 4b/7).
 *
 * `atproto_kem` is optional because every account minted before that release has
 * no such key, and an operation that carries none is still legal. It is never a
 * reuse of `atproto`: the KEM key never signs anything.
 */
export const PlcVerificationMethodsSchema = Schema.Struct({
  atproto: Schema.String,
  atproto_kem: Schema.optional(Schema.String),
});

export const PlcOperationSchema = Schema.Struct({
  type: Schema.Literal('plc_operation'),
  rotationKeys: Schema.mutable(Schema.Array(Schema.String)),
  verificationMethods: PlcVerificationMethodsSchema,
  alsoKnownAs: Schema.mutable(Schema.Array(Schema.String)),
  services: Schema.Struct({
    atproto_pds: Schema.Struct({
      type: Schema.String,
      endpoint: Schema.String,
    }),
  }),
  prev: Schema.NullOr(Schema.String),
  sig: Schema.optional(Schema.String),
});

export type PlcOperation = Schema.Schema.Type<typeof PlcOperationSchema>;

/** The terminal operation. A tombstoned DID is never usable again. */
export const PlcTombstoneSchema = Schema.Struct({
  type: Schema.Literal('plc_tombstone'),
  prev: Schema.String,
  sig: Schema.optional(Schema.String),
});

export type PlcTombstone = Schema.Schema.Type<typeof PlcTombstoneSchema>;

/** Anything the log can hold. */
export const PlcSignedOperationSchema = Schema.Union([
  PlcOperationSchema,
  PlcTombstoneSchema,
]);

export type PlcSignedOperation = Schema.Schema.Type<
  typeof PlcSignedOperationSchema
>;

export const PlcVerificationMethodSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('Multikey'),
  controller: DID,
  publicKeyMultibase: Schema.String,
});

export type PlcVerificationMethod = Schema.Schema.Type<
  typeof PlcVerificationMethodSchema
>;

export const PlcServiceSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  serviceEndpoint: Schema.String,
});

export const PlcDidDocumentSchema = Schema.Struct({
  '@context': Schema.mutable(Schema.Array(Schema.String)),
  id: DID,
  alsoKnownAs: Schema.mutable(Schema.Array(Schema.String)),
  verificationMethod: Schema.mutable(Schema.Array(PlcVerificationMethodSchema)),
  service: Schema.mutable(Schema.Array(PlcServiceSchema)),
});

export type PlcDidDocument = Schema.Schema.Type<typeof PlcDidDocumentSchema>;

/** The operation's fields plus the DID, without `prev`/`sig`: what `/<did>/data` serves. */
export const PlcDataSchema = Schema.Struct({
  did: DID,
  rotationKeys: Schema.mutable(Schema.Array(Schema.String)),
  verificationMethods: PlcVerificationMethodsSchema,
  alsoKnownAs: Schema.mutable(Schema.Array(Schema.String)),
  services: Schema.Struct({
    atproto_pds: Schema.Struct({
      type: Schema.String,
      endpoint: Schema.String,
    }),
  }),
});

export type PlcData = Schema.Schema.Type<typeof PlcDataSchema>;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * The bytes a signature covers: the operation with `sig` omitted *entirely*
 * (not `null`). Derived by omission rather than by listing fields, so a field
 * added to the operation cannot silently fall outside the signature.
 */
const signingBytes = (operation: PlcSignedOperation) =>
  encodeCbor(Struct.omit(operation, ['sig']));

/** The raw sha-256 digest of a signed operation's DAG-CBOR bytes. */
const digestOfSigned = (operation: PlcSignedOperation) =>
  Effect.gen(function* () {
    if (operation.sig === undefined) {
      return yield* new InvalidPlcOperationError({
        message:
          'Operation is not signed; the CID and the DID both cover the signed form',
      });
    }
    return yield* sha256(encodeCbor(operation));
  });

/** The CIDv1 (dag-cbor, sha2-256) a `prev` link points at. */
export const cidOfOperation = (operation: PlcSignedOperation) =>
  Effect.gen(function* () {
    const digest = yield* digestOfSigned(operation);
    return formatCid(cidFromDigest({ codec: CODEC_DAG_CBOR, digest }));
  });

/** The `did:plc` identifier a genesis operation names. */
export const didOfGenesisOperation = (operation: PlcSignedOperation) =>
  Effect.gen(function* () {
    const digest = yield* digestOfSigned(operation);
    // A base32 hash cannot fail the DID pattern; if it does, that is a bug.
    return yield* Schema.decodeEffect(DID)(
      `did:plc:${encodeBase32(digest).slice(0, DID_SUFFIX_LENGTH)}`,
    ).pipe(Effect.orDie);
  });

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

const ensureAtprotoPrefix = (handle: string) =>
  handle.startsWith('at://')
    ? handle
    : `at://${handle.replace(/^https?:\/\//, '')}`;

const ensureHttpPrefix = (endpoint: string) =>
  endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? endpoint
    : `https://${endpoint}`;

/**
 * Builds an unsigned `plc_operation` - a genesis operation when `prev` is null.
 *
 * `alsoKnownAs` is the whole alias list, not one handle: an operation carries
 * the account's full state, so a builder that took a single handle would
 * silently drop aliases on every update.
 *
 * The shape is the spec's, and **third-party mints are accepted as they are**
 * (`3rk7`): a vanity-minted DID arrives with `prev: null`, a placeholder handle
 * and endpoint (`handle.invalid`, `https://pds.invalid`), a temporary `atproto`
 * key and no `atproto_kem` at all, and both this directory and the PDS take it.
 * The claim is an ordinary operation signed by a key the *previous* operation
 * listed: it installs the host's signing and rotation keys and drops the
 * minting key in one go, which is why the claim has to be signed by the key
 * being dropped rather than by the host.
 */
export const buildOperation = (params: {
  readonly alsoKnownAs: readonly string[];
  readonly serviceEndpoint: string;
  readonly rotationKeys: readonly string[];
  readonly signingKey: string;
  /**
   * The account's dedicated KEM key, when the host holding it has one to
   * publish. A move carries the *destination's* key, not the source's, so this
   * is always passed in rather than derived from `signingKey`.
   */
  readonly kemKey?: string;
  readonly prev: string | null;
}) =>
  ({
    type: 'plc_operation',
    rotationKeys: [...params.rotationKeys],
    verificationMethods: {
      atproto: params.signingKey,
      ...(params.kemKey === undefined ? {} : { atproto_kem: params.kemKey }),
    },
    alsoKnownAs: params.alsoKnownAs.map(ensureAtprotoPrefix),
    services: {
      atproto_pds: {
        type: PDS_SERVICE_TYPE,
        endpoint: ensureHttpPrefix(params.serviceEndpoint),
      },
    },
    prev: params.prev,
  }) satisfies PlcOperation;

/**
 * A key this build signs a `did:plc` operation with. Both curves turn up in
 * rotation lists: this build mints P-256, but every account made elsewhere signs
 * with secp256k1 - and so does the operator's offline recovery key, which is the
 * one that undoes a switch.
 */
type OperationSigner = PrivateKey | Secp256k1Key;

/** Signs with whichever curve the key is. */
const signWith = (key: OperationSigner, data: Uint8Array) =>
  key.type === 'secp256k1' ? signSecp256k1({ key, data }) : sign(key, data);

/** Signs an operation with one of its rotation keys. */
export const signOperation = <Operation extends PlcSignedOperation>(params: {
  readonly operation: Operation;
  readonly privateKey: OperationSigner;
}) =>
  Effect.gen(function* () {
    const signature = yield* signWith(
      params.privateKey,
      signingBytes(params.operation),
    );
    return { ...params.operation, sig: base64urlEncode(signature) };
  });

/** Mints an account: the signed genesis operation and the DID it names. */
export const createAccount = (params: {
  readonly handle: string;
  readonly serviceEndpoint: string;
  readonly rotationKeys: readonly string[];
  readonly signingKey: string;
  /** The dedicated KEM key, published alongside `atproto` in the genesis operation. */
  readonly kemKey?: string;
  readonly rotationPrivateKey: OperationSigner;
}) =>
  Effect.gen(function* () {
    const operation = yield* signOperation({
      operation: buildOperation({
        alsoKnownAs: [params.handle],
        serviceEndpoint: params.serviceEndpoint,
        rotationKeys: params.rotationKeys,
        signingKey: params.signingKey,
        ...(params.kemKey === undefined ? {} : { kemKey: params.kemKey }),
        prev: null,
      }),
      privateKey: params.rotationPrivateKey,
    });
    return { did: yield* didOfGenesisOperation(operation), operation };
  });

/** Builds the terminal operation, signed by the key that still controls the DID. */
export const createTombstone = (params: {
  readonly previous: PlcSignedOperation;
  readonly signer: OperationSigner;
}) =>
  Effect.gen(function* () {
    const prev = yield* cidOfOperation(params.previous);
    return yield* signOperation({
      operation: { type: 'plc_tombstone', prev } satisfies PlcTombstone,
      privateKey: params.signer,
    });
  });

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const rotationKeysOf = (operation: PlcSignedOperation) =>
  operation.type === 'plc_operation' ? operation.rotationKeys : [];

/**
 * The shape rules PLC enforces on every operation: every key it names is a
 * did:key, and there are 1..5 rotation keys, most authoritative first.
 *
 * Both curves a `did:plc` uses are read — P-256, which this build mints, and
 * secp256k1, which every account made elsewhere lists. Reading a foreign
 * operation's shape is not the same act as checking it, and a server relaying
 * one to the directory only does the first; the directory (and
 * `verifyOperationSignature` here) does both.
 */
export const validateOperation = (operation: PlcSignedOperation) =>
  Effect.gen(function* () {
    if (operation.type === 'plc_tombstone') {
      return operation;
    }

    // `atproto_kem` is optional: an account minted before it existed names no
    // KEM key, and an absent key is not a key to check.
    const keys = [
      ...Object.values(operation.verificationMethods).flatMap((key) =>
        key === undefined ? [] : [key],
      ),
      ...operation.rotationKeys,
    ];
    for (const key of keys) {
      // A `did:plc` made elsewhere lists **secp256k1** keys, and an operation
      // this server only relays to the directory must not be refused for the
      // curve it names: the directory is what verifies the signature.
      if (
        Result.isFailure(parseP256DidKey(key)) &&
        Result.isFailure(parseSecp256k1DidKey(key))
      ) {
        return yield* new InvalidPlcOperationError({
          message: `Not a did:key this build knows: ${key}`,
        });
      }
    }

    const { rotationKeys } = operation;
    if (rotationKeys.length < 1 || rotationKeys.length > MAX_ROTATION_KEYS) {
      return yield* new InvalidPlcOperationError({
        message: `rotationKeys must hold 1..${MAX_ROTATION_KEYS} keys, got ${rotationKeys.length}`,
      });
    }
    if (new Set(rotationKeys).size !== rotationKeys.length) {
      return yield* new InvalidPlcOperationError({
        message: 'rotationKeys repeats a key, so authority is ambiguous',
      });
    }

    return operation;
  });

/**
 * Verifies an operation's signature against the keys allowed to sign it, and
 * returns the key that matched.
 *
 * A genesis operation is signed by one of its **own** rotation keys; every
 * later operation is signed by one of the **previous** operation's rotation
 * keys. Either curve, whichever the key is. Both reject the high-S twin of a
 * valid signature (WebCrypto cannot, so the P-256 path normalises by hand;
 * noble refuses it), so a signature cannot be rewritten without invalidating
 * the operation's CID.
 */
export const verifyOperationSignature = (params: {
  readonly operation: PlcSignedOperation;
  readonly allowedKeys: readonly string[];
}) =>
  Effect.gen(function* () {
    const { sig } = params.operation;
    if (sig === undefined) {
      return yield* new InvalidPlcSignatureError({
        message: 'Operation carries no signature',
      });
    }

    const signature = base64urlDecode(sig);
    if (signature.length !== SIGNATURE_BYTES) {
      return yield* new InvalidPlcSignatureError({
        message: `Expected a ${SIGNATURE_BYTES}-byte signature, got ${signature.length}`,
      });
    }

    const bytes = signingBytes(params.operation);

    for (const key of params.allowedKeys) {
      // Which curve the key is decides how it is checked. A secp256k1 key that
      // does not verify is a "no" like any other, not an error.
      if (Result.isSuccess(parseP256DidKey(key))) {
        const point = yield* importablePointFromDidKey(key);
        const publicKey = yield* importP256PublicKeyFromPoint(point);
        if (yield* verify(publicKey, bytes, signature)) {
          return key;
        }
      } else if (
        yield* verifySecp256k1({ didKey: key, data: bytes, signature })
      ) {
        return key;
      }
    }

    return yield* new InvalidPlcSignatureError({
      message: `No rotation key authorized this ${params.operation.type}`,
    });
  });

/**
 * Validates a genesis operation and returns the DID it names. The DID is
 * compared for exact equality: the directory recomputes it and rejects a
 * mismatch, so accepting a prefix here would mint identifiers it would refuse.
 */
export const validateGenesisOperation = (params: {
  readonly did: string;
  readonly operation: PlcSignedOperation;
}) =>
  Effect.gen(function* () {
    if (params.operation.type !== 'plc_operation') {
      return yield* new InvalidPlcOperationError({
        message: 'A tombstone cannot be a genesis operation',
      });
    }
    if (params.operation.prev !== null) {
      return yield* new InvalidPlcOperationError({
        message: 'A genesis operation must carry a null prev',
      });
    }

    yield* validateOperation(params.operation);
    const expected = yield* didOfGenesisOperation(params.operation);
    if (expected !== params.did) {
      return yield* new InvalidPlcOperationError({
        message: `Genesis operation names ${expected}, not ${params.did}`,
      });
    }

    yield* verifyOperationSignature({
      operation: params.operation,
      allowedKeys: params.operation.rotationKeys,
    });

    return expected;
  });

/**
 * The rotation keys allowed to sign an operation that extends `previous`,
 * given the operations that extending it nullifies.
 *
 * With nothing nullified this is simply `previous`'s rotation keys. When the
 * operation undoes a fork, PLC requires a key **more authoritative** than the
 * one that signed the first nullified operation: rotation keys are ordered by
 * authority, so only the keys before that one may sign the recovery. Without
 * this, anyone who ever held any rotation key could rewrite history.
 */
export const authorizingKeys = (params: {
  readonly previous: PlcSignedOperation;
  readonly nullifying: readonly PlcSignedOperation[];
}) =>
  Effect.gen(function* () {
    const keys = rotationKeysOf(params.previous);
    if (keys.length === 0) {
      return yield* new InvalidPlcOperationError({
        message: 'A tombstoned DID cannot be extended',
      });
    }

    const [firstNullified] = params.nullifying;
    if (firstNullified === undefined) {
      return keys;
    }

    const disputed = yield* verifyOperationSignature({
      operation: firstNullified,
      allowedKeys: keys,
    });
    return keys.slice(0, keys.indexOf(disputed));
  });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The DID document for a resolved operation.
 *
 * Note the inversion against the old model: `id` is the **account** (the
 * did:plc), and the signing key is demoted to `#atproto`. Rotation keys never
 * appear - they are an op-log detail, not part of the identity a resolver sees.
 */
export const renderDocument = (params: {
  readonly did: DID;
  readonly operation: PlcOperation;
}) => {
  const kemKey = params.operation.verificationMethods.atproto_kem;
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      'https://w3id.org/security/suites/ecdsa-2019/v1',
    ],
    id: params.did,
    alsoKnownAs: [...params.operation.alsoKnownAs],
    verificationMethod: [
      {
        id: `${params.did}#atproto`,
        type: 'Multikey',
        controller: params.did,
        publicKeyMultibase: params.operation.verificationMethods.atproto.slice(
          DID_KEY_PREFIX.length,
        ),
      },
      // The KEM key is a verification method like any other in the document,
      // even though it never verifies a signature: it is what a syncer
      // encapsulates against to agree a commit's shared secret.
      ...(kemKey === undefined
        ? []
        : [
            {
              id: `${params.did}#atproto_kem`,
              type: 'Multikey',
              controller: params.did,
              publicKeyMultibase: kemKey.slice(DID_KEY_PREFIX.length),
            } satisfies PlcVerificationMethod,
          ]),
    ],
    service: [
      {
        id: '#atproto_pds',
        type: params.operation.services.atproto_pds.type,
        serviceEndpoint: params.operation.services.atproto_pds.endpoint,
      },
    ],
  } satisfies PlcDidDocument;
};

/**
 * The PLC "state" an operation resolves to: its fields plus the DID, with `prev`
 * and `sig` dropped. `/<did>/data` serves this - it is the op-log state, not the
 * identity a resolver sees (`renderDocument`).
 */
export const renderData = (params: {
  readonly did: DID;
  readonly operation: PlcOperation;
}) =>
  ({
    did: params.did,
    rotationKeys: [...params.operation.rotationKeys],
    verificationMethods: {
      atproto: params.operation.verificationMethods.atproto,
      ...(params.operation.verificationMethods.atproto_kem === undefined
        ? {}
        : {
            atproto_kem: params.operation.verificationMethods.atproto_kem,
          }),
    },
    alsoKnownAs: [...params.operation.alsoKnownAs],
    services: { atproto_pds: { ...params.operation.services.atproto_pds } },
  }) satisfies PlcData;
