import {
  DidOperationLog,
  DuplicateOperationError,
  MisorderedOperationError,
  TombstonedDidError,
  UnknownDidError,
  didOperationLogLayer,
} from './did-operation-log.js';
import {
  InvalidPlcOperationError,
  InvalidPlcSignatureError,
  type PlcSignedOperation,
  buildOperation,
  cidOfOperation,
  createAccount,
  createTombstone,
  signOperation,
} from './plc-operation.js';
import { type KeyPair, createDIDKey, generateES256KeyPair } from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

/** Each run gets a fresh in-memory layer, so tests do not share state. */
const run = <A, E>(effect: Effect.Effect<A, E, DidOperationLog>) =>
  Effect.runPromise(effect.pipe(Effect.provide(didOperationLogLayer)));

/** A P-256 account minted by us. */
const makeAccount = () =>
  Effect.gen(function* () {
    const rotation = yield* generateES256KeyPair();
    const signing = yield* generateES256KeyPair();
    const rotationKey = yield* createDIDKey(rotation.publicKey);
    const signingKey = yield* createDIDKey(signing.publicKey);

    const { did, operation } = yield* createAccount({
      handle: 'alice.example.com',
      serviceEndpoint: 'https://pds.example.com',
      rotationKeys: [rotationKey],
      signingKey,
      rotationPrivateKey: rotation.privateKey,
    });

    return { did, operation, rotation, rotationKey, signingKey };
  });

/** An update extending `previous`, signed by the rotation key it retires. */
const makeUpdate = (params: {
  readonly previous: PlcSignedOperation;
  readonly rotation: KeyPair;
  readonly rotationKey: string;
  readonly handle: string;
}) =>
  Effect.gen(function* () {
    return yield* signOperation({
      operation: buildOperation({
        alsoKnownAs: [params.handle],
        serviceEndpoint: 'https://pds2.example.com',
        rotationKeys: [params.rotationKey],
        signingKey: params.rotationKey,
        prev: yield* cidOfOperation(params.previous),
      }),
      privateKey: params.rotation.privateKey,
    });
  });

/** An account whose rotation keys are `[root, session]`: root is the authority. */
const makeTwoKeyAccount = () =>
  Effect.gen(function* () {
    const root = yield* generateES256KeyPair();
    const session = yield* generateES256KeyPair();
    const rootKey = yield* createDIDKey(root.publicKey);
    const sessionKey = yield* createDIDKey(session.publicKey);

    const { did, operation } = yield* createAccount({
      handle: 'alice.example.com',
      serviceEndpoint: 'https://pds.example.com',
      rotationKeys: [rootKey, sessionKey],
      signingKey: sessionKey,
      rotationPrivateKey: root.privateKey,
    });

    return { did, operation, root, rootKey, session, sessionKey };
  });

/** A competing operation extending `previous`, signed by `signer`. */
const makeFork = (params: {
  readonly previous: PlcSignedOperation;
  readonly rotationKeys: readonly string[];
  readonly signingKey: string;
  readonly handle: string;
  readonly signer: KeyPair;
}) =>
  Effect.gen(function* () {
    return yield* signOperation({
      operation: buildOperation({
        alsoKnownAs: [params.handle],
        serviceEndpoint: 'https://pds.example.com',
        rotationKeys: [...params.rotationKeys],
        signingKey: params.signingKey,
        prev: yield* cidOfOperation(params.previous),
      }),
      privateKey: params.signer.privateKey,
    });
  });

describe('the directory log', () => {
  it('appends a genesis operation and projects it to a document', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const account = yield* makeAccount();

        const entry = yield* log.append({
          did: account.did,
          operation: account.operation,
        });
        const history = yield* log.history(account.did);
        const head = yield* log.head(account.did);
        const document = yield* log.resolve(account.did);

        return { account, entry, history, head, document };
      }),
    );

    expect(result.entry.seq).toBe(1);
    expect(result.entry.did).toBe(result.account.did);
    expect(result.entry.cid).toBe(
      await Effect.runPromise(cidOfOperation(result.account.operation)),
    );
    expect(result.history).toHaveLength(1);
    expect(result.head?.seq).toBe(1);
    expect(result.document.id).toBe(result.account.did);
    expect(result.document.alsoKnownAs).toEqual(['at://alice.example.com']);
  });

  it('appends an update and resolves the rotated state', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const account = yield* makeAccount();
        const genesis = yield* log.append({
          did: account.did,
          operation: account.operation,
        });

        const update = yield* makeUpdate({
          previous: account.operation,
          rotation: account.rotation,
          rotationKey: account.rotationKey,
          handle: 'alice2.example.com',
        });
        const second = yield* log.append({
          did: account.did,
          operation: update,
        });
        const document = yield* log.resolve(account.did);

        return { genesis, second, update, document };
      }),
    );

    expect(result.second.seq).toBe(2);
    // `prev` is the previous operation's CID, which is what the directory stores.
    expect(result.update.prev).toBe(result.genesis.cid);
    expect(result.document.alsoKnownAs).toEqual(['at://alice2.example.com']);
    expect(result.document.service[0]?.serviceEndpoint).toBe(
      'https://pds2.example.com',
    );
  });

  it('rejects a duplicate operation', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const account = yield* makeAccount();
          const append = () =>
            log.append({ did: account.did, operation: account.operation });
          yield* append();
          return yield* append();
        }),
      ),
    ).rejects.toBeInstanceOf(DuplicateOperationError);
  });

  it('nullifies a forked operation when a more authoritative key recovers', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const account = yield* makeTwoKeyAccount();
        yield* log.append({ did: account.did, operation: account.operation });

        // A fork signed by the LESS authoritative key, as if it had leaked.
        const fork = yield* makeFork({
          previous: account.operation,
          rotationKeys: [account.rootKey, account.sessionKey],
          signingKey: account.sessionKey,
          handle: 'mallory.example.com',
          signer: account.session,
        });
        const forked = yield* log.append({ did: account.did, operation: fork });

        // The recovery points at the SAME operation the fork did, which is what
        // nullifies the fork. It is signed by the root key.
        const recovery = yield* makeFork({
          previous: account.operation,
          rotationKeys: [account.rootKey, account.sessionKey],
          signingKey: account.sessionKey,
          handle: 'alice.example.com',
          signer: account.root,
        });
        yield* log.append({ did: account.did, operation: recovery });

        return {
          forked,
          history: yield* log.history(account.did),
          chain: yield* log.replay(account.did),
          document: yield* log.resolve(account.did),
        };
      }),
    );

    expect(result.forked.nullified).toBe(false);
    expect(result.history).toHaveLength(3);
    expect(result.history.map((entry) => entry.nullified)).toEqual([
      false,
      true,
      false,
    ]);
    // The nullified fork stays in the audit log but drops out of the chain.
    expect(result.chain).toHaveLength(2);
    expect(result.document.alsoKnownAs).toEqual(['at://alice.example.com']);
  });

  it('refuses a recovery signed by a key that does not outrank the fork', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const account = yield* makeTwoKeyAccount();
        yield* log.append({ did: account.did, operation: account.operation });

        const fork = yield* makeFork({
          previous: account.operation,
          rotationKeys: [account.rootKey, account.sessionKey],
          signingKey: account.sessionKey,
          handle: 'mallory.example.com',
          signer: account.session,
        });
        yield* log.append({ did: account.did, operation: fork });

        // Same key as the fork: PLC requires a MORE authoritative one.
        const weakRecovery = yield* makeFork({
          previous: account.operation,
          rotationKeys: [account.rootKey, account.sessionKey],
          signingKey: account.sessionKey,
          handle: 'alice.example.com',
          signer: account.session,
        });

        return {
          rejected: yield* Effect.result(
            log.append({ did: account.did, operation: weakRecovery }),
          ),
          history: yield* log.history(account.did),
        };
      }),
    );

    expect(result.rejected._tag).toBe('Failure');
    expect(result.history).toHaveLength(2);
    expect(result.history.every((entry) => !entry.nullified)).toBe(true);
  });

  it('refuses to undo a recovery the most authoritative key already signed', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const account = yield* makeTwoKeyAccount();
          yield* log.append({ did: account.did, operation: account.operation });

          const fork = yield* makeFork({
            previous: account.operation,
            rotationKeys: [account.rootKey, account.sessionKey],
            signingKey: account.sessionKey,
            handle: 'mallory.example.com',
            signer: account.session,
          });
          yield* log.append({ did: account.did, operation: fork });

          // The root key recovers, which is as authoritative as it gets.
          const recovery = yield* makeFork({
            previous: account.operation,
            rotationKeys: [account.rootKey, account.sessionKey],
            signingKey: account.sessionKey,
            handle: 'alice.example.com',
            signer: account.root,
          });
          yield* log.append({ did: account.did, operation: recovery });

          // Nothing outranks the root key, so its recovery is final.
          const override = yield* makeFork({
            previous: account.operation,
            rotationKeys: [account.rootKey, account.sessionKey],
            signingKey: account.sessionKey,
            handle: 'mallory.example.com',
            signer: account.root,
          });
          return yield* log.append({ did: account.did, operation: override });
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidPlcSignatureError);
  });

  it('refuses to extend an operation that was already nullified', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const account = yield* makeTwoKeyAccount();
          yield* log.append({ did: account.did, operation: account.operation });

          const fork = yield* makeFork({
            previous: account.operation,
            rotationKeys: [account.rootKey, account.sessionKey],
            signingKey: account.sessionKey,
            handle: 'mallory.example.com',
            signer: account.session,
          });
          yield* log.append({ did: account.did, operation: fork });

          const recovery = yield* makeFork({
            previous: account.operation,
            rotationKeys: [account.rootKey, account.sessionKey],
            signingKey: account.sessionKey,
            handle: 'alice.example.com',
            signer: account.root,
          });
          yield* log.append({ did: account.did, operation: recovery });

          // Extending the nullified fork would resurrect it.
          const resurrect = yield* makeFork({
            previous: fork,
            rotationKeys: [account.rootKey, account.sessionKey],
            signingKey: account.sessionKey,
            handle: 'mallory.example.com',
            signer: account.root,
          });
          return yield* log.append({ did: account.did, operation: resurrect });
        }),
      ),
    ).rejects.toBeInstanceOf(MisorderedOperationError);
  });

  it('rejects an update signed by a key the head did not authorize', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const account = yield* makeAccount();
          yield* log.append({ did: account.did, operation: account.operation });

          const intruder = yield* generateES256KeyPair();
          const intruderKey = yield* createDIDKey(intruder.publicKey);
          const update = yield* makeFork({
            previous: account.operation,
            rotationKeys: [intruderKey],
            signingKey: intruderKey,
            handle: 'alice.example.com',
            signer: intruder,
          });
          return yield* log.append({ did: account.did, operation: update });
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidPlcSignatureError);
  });

  it('rejects an operation whose prev is not in the log', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const account = yield* makeAccount();
          yield* log.append({ did: account.did, operation: account.operation });

          const orphan = yield* signOperation({
            operation: buildOperation({
              alsoKnownAs: ['alice.example.com'],
              serviceEndpoint: 'https://pds.example.com',
              rotationKeys: [account.rotationKey],
              signingKey: account.rotationKey,
              prev: 'bafyreiblcw5xjipi44j5unnd3lnamlfxu6jay5pp42dl534omgwzgrny4y',
            }),
            privateKey: account.rotation.privateKey,
          });
          return yield* log.append({ did: account.did, operation: orphan });
        }),
      ),
    ).rejects.toBeInstanceOf(MisorderedOperationError);
  });

  it('rejects a second genesis operation for the same DID', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const account = yield* makeAccount();
          yield* log.append({ did: account.did, operation: account.operation });

          // A distinct genesis operation, so not a duplicate: it simply has no
          // operation to attach to.
          const other = yield* makeAccount();
          return yield* log.append({
            did: account.did,
            operation: other.operation,
          });
        }),
      ),
    ).rejects.toBeInstanceOf(MisorderedOperationError);
  });

  it('rejects a genesis operation submitted for a DID it does not name', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const alice = yield* makeAccount();
          const bob = yield* makeAccount();
          return yield* log.append({
            did: alice.did,
            operation: bob.operation,
          });
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidPlcOperationError);
  });

  it('fails to resolve a DID that has no operations', async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const log = yield* DidOperationLog;
          const account = yield* makeAccount();
          return yield* log.resolve(account.did);
        }),
      ),
    ).rejects.toBeInstanceOf(UnknownDidError);
  });

  it('retires a DID with a tombstone, which then has no document', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const account = yield* makeAccount();
        yield* log.append({ did: account.did, operation: account.operation });

        const tombstone = yield* createTombstone({
          previous: account.operation,
          signer: account.rotation.privateKey,
        });
        yield* log.append({ did: account.did, operation: tombstone });

        const history = yield* log.history(account.did);
        // `flip` gives the failure itself, so the test asserts on the error
        // rather than branching on a tag.
        const tombstoned = yield* Effect.flip(log.resolve(account.did));
        return { history, tombstoned };
      }),
    );

    expect(result.history).toHaveLength(2);
    expect(result.tombstoned).toBeInstanceOf(TombstonedDidError);
  });

  it('keeps separate DIDs on separate chains', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const alice = yield* makeAccount();
        const bob = yield* makeAccount();

        yield* log.append({ did: alice.did, operation: alice.operation });
        yield* log.append({ did: bob.did, operation: bob.operation });

        return {
          aliceHistory: yield* log.history(alice.did),
          bobHistory: yield* log.history(bob.did),
          aliceDid: alice.did,
          bobDid: bob.did,
        };
      }),
    );

    expect(result.aliceHistory).toHaveLength(1);
    expect(result.bobHistory).toHaveLength(1);
    expect(result.aliceHistory[0]?.did).toBe(result.aliceDid);
    expect(result.bobHistory[0]?.did).toBe(result.bobDid);
  });

  it('does not mutate a chain when an append is rejected', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* DidOperationLog;
        const account = yield* makeAccount();
        yield* log.append({ did: account.did, operation: account.operation });

        const rejected = yield* Effect.result(
          log.append({ did: account.did, operation: account.operation }),
        );
        return { rejected, history: yield* log.history(account.did) };
      }),
    );

    expect(result.rejected._tag).toBe('Failure');
    expect(result.history).toHaveLength(1);
  });
});
