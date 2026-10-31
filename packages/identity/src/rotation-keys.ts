import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { type DID } from '@eoa/core';
import type { PrivateKey } from '@eoa/crypto';

/**
 * Custodial rotation keys: the directory holds one per account and signs every
 * operation that changes that account on the owner's behalf.
 *
 * This is the posture a PDS has, for the reason PLC split the keys in the first
 * place: the rotation key signs the op log, while the signing key (which writes
 * to the repository) is a separate key that can be rotated without touching
 * identity - and a compromised signing key cannot rotate anything. A rotation
 * key never appears in a DID document: it is an op-log detail.
 *
 * Storage is a seam, not a detail. The in-memory layer is the only
 * implementation today; a durable one is a storage concern the operation model
 * does not care about, and the keys are generated extractable so it stays
 * possible.
 */

export class DuplicateRotationKeyError extends Schema.TaggedError<DuplicateRotationKeyError>()(
  'DuplicateRotationKeyError',
  {
    did: Schema.String,
    message: Schema.String,
  },
) {}

export class UnknownRotationKeyError extends Schema.TaggedError<UnknownRotationKeyError>()(
  'UnknownRotationKeyError',
  {
    did: Schema.String,
    message: Schema.String,
  },
) {}

export interface RotationKeyStoreShape {
  /** Take custody of an account's rotation key. */
  readonly store: (params: {
    readonly did: DID;
    readonly privateKey: PrivateKey;
  }) => Effect.Effect<void, DuplicateRotationKeyError>;
  /** The rotation key that currently controls a DID. */
  readonly get: (
    did: DID,
  ) => Effect.Effect<PrivateKey, UnknownRotationKeyError>;
  /** Swap in a new rotation key, once the rotation operation has been accepted. */
  readonly replace: (params: {
    readonly did: DID;
    readonly privateKey: PrivateKey;
  }) => Effect.Effect<void, UnknownRotationKeyError>;
}

export class RotationKeyStore extends Context.Service<
  RotationKeyStore,
  RotationKeyStoreShape
>()('@eoa/identity/RotationKeyStore') {}

export const rotationKeyStoreLayer: Layer.Layer<RotationKeyStore> =
  Layer.effect(
    RotationKeyStore,
    Effect.gen(function* () {
      const state = yield* Ref.make(new Map<string, PrivateKey>());

      const store: RotationKeyStoreShape['store'] = Effect.fn(
        'RotationKeyStore.store',
      )(function* (params: { did: DID; privateKey: PrivateKey }) {
        if ((yield* Ref.get(state)).has(params.did)) {
          return yield* new DuplicateRotationKeyError({
            did: params.did,
            message: `${params.did} already has a rotation key in custody`,
          });
        }
        yield* Ref.update(state, (current) =>
          new Map(current).set(params.did, params.privateKey),
        );
      });

      const get: RotationKeyStoreShape['get'] = Effect.fn(
        'RotationKeyStore.get',
      )(function* (did: DID) {
        const key = (yield* Ref.get(state)).get(did);
        if (key === undefined) {
          return yield* new UnknownRotationKeyError({
            did,
            message: `No rotation key is held for ${did}`,
          });
        }
        return key;
      });

      const replace: RotationKeyStoreShape['replace'] = Effect.fn(
        'RotationKeyStore.replace',
      )(function* (params: { did: DID; privateKey: PrivateKey }) {
        if (!(yield* Ref.get(state)).has(params.did)) {
          return yield* new UnknownRotationKeyError({
            did: params.did,
            message: `No rotation key is held for ${params.did}`,
          });
        }
        yield* Ref.update(state, (current) =>
          new Map(current).set(params.did, params.privateKey),
        );
      });

      return RotationKeyStore.of({ store, get, replace });
    }),
  );
