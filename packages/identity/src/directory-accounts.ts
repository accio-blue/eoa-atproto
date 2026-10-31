import { Context, Effect, Layer, Schema } from 'effect';
import {
  type CryptoError,
  createDIDKey,
  generateES256KeyPair,
} from '@eoa/crypto';
import {
  DidOperationLog,
  type LogError,
  TombstonedDidError,
  UnknownDidError,
} from './did-operation-log.js';
import {
  type DuplicateRotationKeyError,
  RotationKeyStore,
  type UnknownRotationKeyError,
} from './rotation-keys.js';
import {
  type PlcError,
  type PlcSignedOperation,
  buildOperation,
  cidOfOperation,
  createAccount,
  createTombstone,
  signOperation,
} from './plc-operation.js';
import { type DID } from '@eoa/core';

/**
 * The account lifecycle, with the directory as the only writer.
 *
 * Because we hold the rotation key custodially, the directory is what mints
 * accounts, changes their state and retires them - signing each operation
 * itself. The **signing key is a parameter**, never minted here: it belongs to
 * the PDS, which uses it to write to the repository, and the directory never
 * sees it. Custody of both would collapse the split this design exists for.
 *
 * Ordering matters in two places, and both are deliberate:
 *
 * - on creation, custody comes *after* signing, because the DID does not exist
 *   until the genesis operation has been signed and hashed;
 * - on rotation, custody moves *after* the log accepts the operation, because
 *   until then the old key is still the one that controls the DID.
 *
 * There are **two** rotation keys, not one, and their order is the authority
 * (`dhs6`). The host's key is the one in custody, and it signs every operation
 * above. The operator's **recovery key** is a parameter, listed *first* and
 * never held: a plain append may be signed by any listed key, but undoing one
 * takes a key listed before the key that signed it (`authorizingKeys`), so the
 * host can run an account and only the operator can undo the host. Minting with
 * one key, as this used to, mints an account nobody can ever recover.
 */

export type AccountOperation = {
  readonly did: DID;
  readonly operation: PlcSignedOperation;
};

/** Reported when the directory itself is unreachable or refused the request. */
export class DirectoryRequestError extends Schema.TaggedError<DirectoryRequestError>()(
  'DirectoryRequestError',
  {
    message: Schema.String,
  },
) {}

/** Everything an account change can fail with. */
export type AccountError =
  | DirectoryRequestError
  | CryptoError
  | PlcError
  | LogError
  | DuplicateRotationKeyError
  | UnknownRotationKeyError
  | UnknownDidError
  | TombstonedDidError;

export interface DirectoryAccountsShape {
  /** Mint an account: a fresh rotation key in custody, a signed genesis, a DID. */
  readonly create: (params: {
    readonly handle: string;
    readonly serviceEndpoint: string;
    readonly signingKey: string;
    /** The account's dedicated KEM key, when the host already holds one. */
    readonly kemKey?: string;
  }) => Effect.Effect<AccountOperation, AccountError>;
  /**
   * Replace the account's state. `alsoKnownAs` is the whole alias list, not one
   * handle: the operation carries the account's full state, so the caller
   * decides the alias policy rather than having one inferred here.
   */
  readonly update: (params: {
    readonly did: DID;
    readonly alsoKnownAs: readonly string[];
    readonly serviceEndpoint: string;
    readonly signingKey: string;
    /**
     * The KEM key to publish. Absent means the account's own, carried over from
     * the head operation — the field is state, and an update that forgot it
     * would retract a key the account still holds.
     */
    readonly kemKey?: string;
  }) => Effect.Effect<AccountOperation, AccountError>;
  /** Rotate the rotation key itself - the old key signs its own retirement. */
  readonly rotateRotationKey: (
    did: DID,
  ) => Effect.Effect<AccountOperation, AccountError>;
  /** Retire the account permanently. */
  readonly tombstone: (
    did: DID,
  ) => Effect.Effect<AccountOperation, AccountError>;
}

export class DirectoryAccounts extends Context.Service<
  DirectoryAccounts,
  DirectoryAccountsShape
>()('@eoa/identity/DirectoryAccounts') {}

/** A fresh P-256 rotation key, as the pair of things the callers need. */
const generateRotationKey = () =>
  Effect.gen(function* () {
    const keyPair = yield* generateES256KeyPair();
    return {
      privateKey: keyPair.privateKey,
      didKey: yield* createDIDKey(keyPair.publicKey),
    };
  });

/**
 * The account lifecycle, over the log and the key store.
 *
 * `recoveryRotationKey` is the operator's offline key, as a `did:key`: public,
 * listed first on every account this directory mints or rotates, and never
 * stored here.
 */
const makeDirectoryAccounts = (recoveryRotationKey: string) =>
  Effect.gen(function* () {
    const keys = yield* RotationKeyStore;
    const log = yield* DidOperationLog;

    /**
     * The two rotation keys, operator first. The host's key is what the store
     * hands out; the recovery key is only ever named.
     */
    const rotationKeys = (host: string) => [recoveryRotationKey, host];

    /** The head operation, or a failure explaining why there is none. */
    const headOperation = (did: DID) =>
      Effect.gen(function* () {
        const chain = yield* log.replay(did);
        const previous = chain.at(-1);
        if (previous === undefined) {
          return yield* new UnknownDidError({
            did,
            message: `No operations are logged for ${did}`,
          });
        }
        if (previous.type === 'plc_tombstone') {
          return yield* new TombstonedDidError({
            did,
            message: `${did} is tombstoned and cannot be changed`,
          });
        }
        return previous;
      });

    const create: DirectoryAccountsShape['create'] = Effect.fn(
      'DirectoryAccounts.create',
    )(function* (params: {
      handle: string;
      serviceEndpoint: string;
      signingKey: string;
      kemKey?: string;
    }) {
      const rotation = yield* generateRotationKey();
      const { did, operation } = yield* createAccount({
        handle: params.handle,
        serviceEndpoint: params.serviceEndpoint,
        rotationKeys: rotationKeys(rotation.didKey),
        signingKey: params.signingKey,
        ...(params.kemKey === undefined ? {} : { kemKey: params.kemKey }),
        rotationPrivateKey: rotation.privateKey,
      });

      // A crash between these two leaves an orphaned key, which is harmless -
      // a retry mints a fresh account. The reverse order would leave an account
      // nobody can ever rotate.
      yield* keys.store({ did, privateKey: rotation.privateKey });
      yield* log.append({ did, operation });

      return { did, operation };
    });

    const update: DirectoryAccountsShape['update'] = Effect.fn(
      'DirectoryAccounts.update',
    )(function* (params: {
      did: DID;
      alsoKnownAs: readonly string[];
      serviceEndpoint: string;
      signingKey: string;
      kemKey?: string;
    }) {
      const privateKey = yield* keys.get(params.did);
      const previous = yield* headOperation(params.did);
      const kemKey = params.kemKey ?? previous.verificationMethods.atproto_kem;

      const operation = yield* signOperation({
        operation: buildOperation({
          alsoKnownAs: params.alsoKnownAs,
          serviceEndpoint: params.serviceEndpoint,
          rotationKeys: previous.rotationKeys,
          signingKey: params.signingKey,
          ...(kemKey === undefined ? {} : { kemKey }),
          prev: yield* cidOfOperation(previous),
        }),
        privateKey,
      });

      yield* log.append({ did: params.did, operation });
      return { did: params.did, operation };
    });

    const rotateRotationKey: DirectoryAccountsShape['rotateRotationKey'] =
      Effect.fn('DirectoryAccounts.rotateRotationKey')(function* (did: DID) {
        const privateKey = yield* keys.get(did);
        const previous = yield* headOperation(did);
        const next = yield* generateRotationKey();

        // Signed by the key being retired: that is exactly what makes the new
        // key the only one that can sign anything after it. The operator's key
        // stays where it is - a rotation retires the host's key, not the
        // recovery path.
        const operation = yield* signOperation({
          operation: buildOperation({
            alsoKnownAs: previous.alsoKnownAs,
            serviceEndpoint: previous.services.atproto_pds.endpoint,
            rotationKeys: rotationKeys(next.didKey),
            signingKey: previous.verificationMethods.atproto,
            // A rotation retires the rotation key, not the KEM key: the field is
            // the account's state and has to survive every operation.
            ...(previous.verificationMethods.atproto_kem === undefined
              ? {}
              : { kemKey: previous.verificationMethods.atproto_kem }),
            prev: yield* cidOfOperation(previous),
          }),
          privateKey,
        });

        yield* log.append({ did, operation });
        yield* keys.replace({ did, privateKey: next.privateKey });

        return { did, operation };
      });

    const tombstone: DirectoryAccountsShape['tombstone'] = Effect.fn(
      'DirectoryAccounts.tombstone',
    )(function* (did: DID) {
      const privateKey = yield* keys.get(did);
      const previous = yield* headOperation(did);

      const operation = yield* createTombstone({
        previous,
        signer: privateKey,
      });
      yield* log.append({ did, operation });

      return { did, operation };
    });

    return DirectoryAccounts.of({
      create,
      update,
      rotateRotationKey,
      tombstone,
    });
  });

/**
 * The layer the directory provides. The operator's key is a **parameter rather
 * than a config read**, so a directory that has no operator cannot be built by
 * accident.
 */
export const directoryAccountsLayer = (params: {
  readonly recoveryRotationKey: string;
}): Layer.Layer<DirectoryAccounts, never, DidOperationLog | RotationKeyStore> =>
  Layer.effect(
    DirectoryAccounts,
    makeDirectoryAccounts(params.recoveryRotationKey),
  );
