import {
  DidOperationLog,
  TombstonedDidError,
  UnknownDidError,
  didOperationLogLayer,
} from './did-operation-log.js';
import {
  DirectoryAccounts,
  directoryAccountsLayer,
} from './directory-accounts.js';
import { Effect, Layer } from 'effect';
import {
  InvalidPlcSignatureError,
  type PlcSignedOperation,
  buildOperation,
  cidOfOperation,
  createAccount,
  signOperation,
} from './plc-operation.js';
import {
  RotationKeyStore,
  UnknownRotationKeyError,
  rotationKeyStoreLayer,
} from './rotation-keys.js';
import { createDIDKey, generateES256KeyPair } from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { type DID } from '@eoa/core';
import { TEST_RECOVERY_ROTATION_KEY } from './recovery-key.js';

/**
 * A directory over the in-memory log and key store. `Layer` memoises within one
 * build, so the service, the log and the store the tests read are the same
 * instances the service writes to.
 *
 * `recoveryRotationKey` is the operator's key, listed first on every account.
 * The tests name the shared fixture: none of them is an operator. The one that
 * is builds its own directory with a key it can sign with.
 */
const directoryWith = (recoveryRotationKey: string) =>
  Layer.mergeAll(
    directoryAccountsLayer({ recoveryRotationKey }).pipe(
      Layer.provide(
        Layer.mergeAll(didOperationLogLayer, rotationKeyStoreLayer),
      ),
    ),
    didOperationLogLayer,
    rotationKeyStoreLayer,
  );

const TestLayer = directoryWith(TEST_RECOVERY_ROTATION_KEY);

/** The rotation keys an operation lists, most authoritative first. */
const rotationKeysOf = (operation: PlcSignedOperation) =>
  operation.type === 'plc_operation' ? operation.rotationKeys : [];

/** A P-256 key the PDS would own: it signs repo writes, not the op log. */
const makeSigningKey = () =>
  Effect.gen(function* () {
    const keyPair = yield* generateES256KeyPair();
    return yield* createDIDKey(keyPair.publicKey);
  });

/** The did:key of the rotation key currently in custody for a DID. */
const rotationDidKey = (did: DID) =>
  Effect.gen(function* () {
    const store = yield* RotationKeyStore;
    const privateKey = yield* store.get(did);
    return yield* createDIDKey(privateKey.publicKey);
  });

describe('custodial accounts', () => {
  it('mints an account, custodies its rotation key, and keeps it out of the document', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const accounts = yield* DirectoryAccounts;
        const log = yield* DidOperationLog;
        const signingKey = yield* makeSigningKey();

        const created = yield* accounts.create({
          handle: 'alice.example.com',
          serviceEndpoint: 'pds.example.com',
          signingKey,
        });

        return {
          created,
          signingKey,
          rotationKey: yield* rotationDidKey(created.did),
          document: yield* log.resolve(created.did),
          history: yield* log.history(created.did),
        };
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.created.did).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(result.history).toHaveLength(1);
    expect(result.document.id).toBe(result.created.did);
    expect(result.document.alsoKnownAs).toEqual(['at://alice.example.com']);
    expect(result.document.service[0]?.serviceEndpoint).toBe(
      'https://pds.example.com',
    );
    // The operator's recovery key is listed *first*, so it outranks the host's
    // key - the key that is in custody and signs this operation.
    expect(rotationKeysOf(result.created.operation)).toEqual([
      TEST_RECOVERY_ROTATION_KEY,
      result.rotationKey,
    ]);

    // The document carries the PDS's signing key...
    expect(result.document.verificationMethod[0]?.publicKeyMultibase).toBe(
      result.signingKey.slice('did:key:'.length),
    );
    // ...while the operation declares a rotation key that is a different key,
    // and that key never reaches the document a resolver sees. Neither does the
    // operator's: rotation keys are an op-log detail, and this one is not even
    // held here.
    expect(JSON.stringify(result.history[0]?.operation)).toContain(
      result.rotationKey,
    );
    expect(result.rotationKey).not.toBe(result.signingKey);
    expect(JSON.stringify(result.document)).not.toContain(
      result.rotationKey.slice('did:key:'.length),
    );
    expect(JSON.stringify(result.document)).not.toContain(
      TEST_RECOVERY_ROTATION_KEY.slice('did:key:'.length),
    );
  });

  it('changes the account state, signed by the custodied key', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const accounts = yield* DirectoryAccounts;
        const log = yield* DidOperationLog;
        const nextSigningKey = yield* makeSigningKey();

        const created = yield* accounts.create({
          handle: 'alice.example.com',
          serviceEndpoint: 'https://pds.example.com',
          signingKey: yield* makeSigningKey(),
        });

        const updated = yield* accounts.update({
          did: created.did,
          alsoKnownAs: ['alice2.example.com'],
          serviceEndpoint: 'pds2.example.com',
          signingKey: nextSigningKey,
        });

        return {
          updated,
          nextSigningKey,
          history: yield* log.history(created.did),
          document: yield* log.resolve(created.did),
        };
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.history).toHaveLength(2);
    expect(result.history[1]?.seq).toBe(2);
    // The update extends the genesis: `prev` is its CID, which is what the log
    // checked before accepting it.
    expect(JSON.stringify(result.updated.operation)).toContain(
      result.history[0]?.cid ?? '',
    );
    expect(result.document.alsoKnownAs).toEqual(['at://alice2.example.com']);
    expect(result.document.service[0]?.serviceEndpoint).toBe(
      'https://pds2.example.com',
    );
    expect(result.document.verificationMethod[0]?.publicKeyMultibase).toBe(
      result.nextSigningKey.slice('did:key:'.length),
    );
  });

  it('rotates the rotation key, and the new key is the one that controls the DID', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const accounts = yield* DirectoryAccounts;
        const created = yield* accounts.create({
          handle: 'alice.example.com',
          serviceEndpoint: 'https://pds.example.com',
          signingKey: yield* makeSigningKey(),
        });

        const before = yield* rotationDidKey(created.did);
        const rotated = yield* accounts.rotateRotationKey(created.did);
        const after = yield* rotationDidKey(created.did);

        // Only the new key can authorize what comes next.
        const updated = yield* accounts.update({
          did: created.did,
          alsoKnownAs: ['alice.example.com'],
          serviceEndpoint: 'https://pds3.example.com',
          signingKey: yield* makeSigningKey(),
        });

        return { before, after, rotated, updated };
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.after).not.toBe(result.before);
    expect(JSON.stringify(result.rotated.operation)).toContain(result.after);
    expect(JSON.stringify(result.rotated.operation)).not.toContain(
      result.before,
    );
    // A rotation retires the host's key, not the recovery path: the operator is
    // still listed first, which is what keeps the account undoable.
    expect(rotationKeysOf(result.rotated.operation)).toEqual([
      TEST_RECOVERY_ROTATION_KEY,
      result.after,
    ]);
    // The account still works afterwards: the store moved with the rotation.
    expect(JSON.stringify(result.updated.operation)).toContain(result.after);
  });

  it('lets the operator undo the host key, and never the host the operator', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // The test *is* the operator here, so it needs a key it can sign with:
        // the shared fixture is only ever named, never used.
        const operator = yield* generateES256KeyPair();
        const operatorKey = yield* createDIDKey(operator.publicKey);

        return yield* Effect.gen(function* () {
          const accounts = yield* DirectoryAccounts;
          const log = yield* DidOperationLog;
          const store = yield* RotationKeyStore;

          const created = yield* accounts.create({
            handle: 'alice.example.com',
            serviceEndpoint: 'https://pds.example.com',
            signingKey: yield* makeSigningKey(),
          });

          // The host rotates its own key. The operator stays where it is.
          const rotated = yield* accounts.rotateRotationKey(created.did);
          const hostKey = yield* store.get(created.did);

          // The operator undoes the rotation: attach to the genesis and nullify
          // everything after it. Signed by a key *listed ahead* of the key that
          // signed the rotation, which is the whole mechanism.
          const recovery = yield* signOperation({
            operation: buildOperation({
              alsoKnownAs: ['alice.example.com'],
              serviceEndpoint: 'https://pds-recovered.example.com',
              rotationKeys: rotationKeysOf(created.operation),
              signingKey: yield* makeSigningKey(),
              prev: yield* cidOfOperation(created.operation),
            }),
            privateKey: operator.privateKey,
          });
          yield* log.append({ did: created.did, operation: recovery });

          // The host tries the same to the operator's operation. Nothing is
          // listed ahead of the operator's key, so there is no key that may
          // sign this - the host's own key included.
          const usurper = yield* signOperation({
            operation: buildOperation({
              alsoKnownAs: ['alice.example.com'],
              serviceEndpoint: 'https://pds-hijacked.example.com',
              rotationKeys: rotationKeysOf(recovery),
              signingKey: yield* makeSigningKey(),
              prev: yield* cidOfOperation(created.operation),
            }),
            privateKey: hostKey,
          });

          return {
            rotated,
            rejected: yield* Effect.flip(
              log.append({ did: created.did, operation: usurper }),
            ),
            history: yield* log.history(created.did),
            document: yield* log.resolve(created.did),
          };
        }).pipe(Effect.provide(directoryWith(operatorKey)));
      }),
    );

    // The rotation happened, and then stopped counting: it is history, marked
    // nullified, not deleted.
    expect(result.rotated.operation.type).toBe('plc_operation');
    expect(result.history).toHaveLength(3);
    expect(result.history[1]?.nullified).toBe(true);
    expect(result.history[2]?.nullified).toBe(false);
    expect(result.document.service[0]?.serviceEndpoint).toBe(
      'https://pds-recovered.example.com',
    );

    // ...and the host could not do the same to the operator.
    expect(result.rejected).toBeInstanceOf(InvalidPlcSignatureError);
  });

  it('retires an account with a tombstone, after which nothing changes', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const accounts = yield* DirectoryAccounts;
        const log = yield* DidOperationLog;
        const created = yield* accounts.create({
          handle: 'alice.example.com',
          serviceEndpoint: 'https://pds.example.com',
          signingKey: yield* makeSigningKey(),
        });

        const tombstone = yield* accounts.tombstone(created.did);
        return {
          tombstone,
          changed: yield* Effect.flip(
            accounts.update({
              did: created.did,
              alsoKnownAs: ['alice.example.com'],
              serviceEndpoint: 'https://pds.example.com',
              signingKey: yield* makeSigningKey(),
            }),
          ),
          resolved: yield* Effect.flip(log.resolve(created.did)),
          history: yield* log.history(created.did),
        };
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.tombstone.operation.type).toBe('plc_tombstone');
    expect(result.changed).toBeInstanceOf(TombstonedDidError);
    expect(result.resolved).toBeInstanceOf(TombstonedDidError);
    expect(result.history).toHaveLength(2);
  });

  it('refuses to change an account whose key it does not hold', async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const accounts = yield* DirectoryAccounts;
        const log = yield* DidOperationLog;

        // Minted and logged without the accounts service, so nobody handed the
        // directory the rotation key: custody is what makes an account ours.
        const rotation = yield* generateES256KeyPair();
        const { did, operation } = yield* createAccount({
          handle: 'bob.example.com',
          serviceEndpoint: 'https://pds.example.com',
          rotationKeys: [yield* createDIDKey(rotation.publicKey)],
          signingKey: yield* makeSigningKey(),
          rotationPrivateKey: rotation.privateKey,
        });
        yield* log.append({ did, operation });

        return yield* Effect.flip(
          accounts.update({
            did,
            alsoKnownAs: ['bob.example.com'],
            serviceEndpoint: 'https://pds.example.com',
            signingKey: yield* makeSigningKey(),
          }),
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(error).toBeInstanceOf(UnknownRotationKeyError);
  });

  it('mints a fresh rotation key per account, so DIDs never collide', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const accounts = yield* DirectoryAccounts;
        const handle = 'alice.example.com';
        const serviceEndpoint = 'https://pds.example.com';

        const first = yield* accounts.create({
          handle,
          serviceEndpoint,
          signingKey: yield* makeSigningKey(),
        });
        const second = yield* accounts.create({
          handle,
          serviceEndpoint,
          signingKey: yield* makeSigningKey(),
        });

        return {
          first,
          second,
          cids: [
            yield* cidOfOperation(first.operation),
            yield* cidOfOperation(second.operation),
          ],
        };
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.first.did).not.toBe(result.second.did);
    expect(result.cids[0]).not.toBe(result.cids[1]);
  });

  it('fails to resolve a DID that was never created', async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const rotation = yield* generateES256KeyPair();

        // Minted but never submitted: the directory has never seen it.
        const { did } = yield* createAccount({
          handle: 'nobody.example.com',
          serviceEndpoint: 'https://pds.example.com',
          rotationKeys: [yield* createDIDKey(rotation.publicKey)],
          signingKey: yield* makeSigningKey(),
          rotationPrivateKey: rotation.privateKey,
        });

        return yield* Effect.flip(log.resolve(did));
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(error).toBeInstanceOf(UnknownDidError);
  });
});
