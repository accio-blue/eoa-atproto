import {
  InvalidPlcOperationError,
  InvalidPlcSignatureError,
  type PlcSignedOperation,
  authorizingKeys,
  buildOperation,
  cidOfOperation,
  createAccount,
  createTombstone,
  didOfGenesisOperation,
  renderDocument,
  signOperation,
  validateGenesisOperation,
  validateOperation,
  verifyOperationSignature,
} from './plc-operation.js';
import {
  base64urlDecode,
  createDIDKey,
  generateES256KeyPair,
  isSignatureNormalized,
} from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

/**
 * Real operations lifted from plc.directory, with the DID and CIDs that
 * directory computed. These are the compatibility contract: if our encoding
 * drifts by one byte, these assertions fail - which is the only way to know,
 * because our own encoder would happily agree with itself.
 */
type RealEntry = {
  readonly cid: string;
  readonly operation: PlcSignedOperation;
};

const REAL_GENESIS: RealEntry & { readonly did: string } = {
  did: 'did:plc:fmk3w5fb5dtrhwrvupnnubrm',
  cid: 'bafyreiblcw5xjipi44j5unnd3lnamlfxu6jay5pp42dl534omgwzgrny4y',
  operation: {
    sig: 'vTVm25A3bXUwgfM0zdmFsXAkcb8EOQbgLActoMzlLLx0CUr59_Q8RBt9T-_A5HKZxkNZhBsX2_GQJcc8YgeeUQ',
    prev: null,
    type: 'plc_operation',
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: 'https://morel.us-east.host.bsky.network',
      },
    },
    alsoKnownAs: ['at://arbust.bsky.social'],
    rotationKeys: [
      'did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg',
      'did:key:zQ3shpKnbdPx3g3CmPf5cRVTPe1HtSwVn5ish3wSnDPQCbLJK',
    ],
    verificationMethods: {
      atproto: 'did:key:zQ3shv9m3wHyWE29JcGRcG3koR2C8QoYSd2iMVnAkrbWNF5hG',
    },
  },
};

const REAL_CHAIN: readonly [RealEntry, RealEntry] = [
  {
    cid: 'bafyreigp6shzy6dlcxuowwoxz7u5nemdrkad2my5zwzpwilcnhih7bw6zm',
    operation: {
      sig: '9NuYV7AqwHVTc0YuWzNV3CJafsSZWH7qCxHRUIP2xWlB-YexXC1OaYAnUayiCXLVzRQ8WBXIqF-SvZdNalwcjA',
      prev: null,
      type: 'plc_operation',
      services: {
        atproto_pds: {
          type: 'AtprotoPersonalDataServer',
          endpoint: 'https://bsky.social',
        },
      },
      alsoKnownAs: ['at://bluesky-team.bsky.social'],
      rotationKeys: [
        'did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg',
        'did:key:zQ3shpKnbdPx3g3CmPf5cRVTPe1HtSwVn5ish3wSnDPQCbLJK',
      ],
      verificationMethods: {
        atproto: 'did:key:zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF',
      },
    },
  },
  {
    cid: 'bafyreihmuvr3frdvd6vmdhucih277prdcfcezf67lasg5oekxoimnunjoq',
    operation: {
      sig: '1mEWzRtFOgeRXH-YCSPTxb990JOXxa__n8Qw6BOKl7Ndm6OFFmwYKiiMqMCpAbxpnGjF5abfIsKc7u3a77Cbnw',
      prev: 'bafyreigp6shzy6dlcxuowwoxz7u5nemdrkad2my5zwzpwilcnhih7bw6zm',
      type: 'plc_operation',
      services: {
        atproto_pds: {
          type: 'AtprotoPersonalDataServer',
          endpoint: 'https://bsky.social',
        },
      },
      alsoKnownAs: ['at://bsky.app'],
      rotationKeys: [
        'did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg',
        'did:key:zQ3shpKnbdPx3g3CmPf5cRVTPe1HtSwVn5ish3wSnDPQCbLJK',
      ],
      verificationMethods: {
        atproto: 'did:key:zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF',
      },
    },
  },
];

/** A P-256 account minted by us, with every key a fresh did:key. */
const makeAccount = (params: {
  readonly handle: string;
  readonly serviceEndpoint: string;
}) =>
  Effect.gen(function* () {
    const rotation = yield* generateES256KeyPair();
    const signing = yield* generateES256KeyPair();
    const rotationKey = yield* createDIDKey(rotation.publicKey);
    const signingKey = yield* createDIDKey(signing.publicKey);

    const { did, operation } = yield* createAccount({
      handle: params.handle,
      serviceEndpoint: params.serviceEndpoint,
      rotationKeys: [rotationKey],
      signingKey,
      rotationPrivateKey: rotation.privateKey,
    });

    return { did, operation, rotation, rotationKey, signing, signingKey };
  });

describe('the real directory’s operations', () => {
  it('derives the DID and the CID plc.directory derived', async () => {
    const derived = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          did: yield* didOfGenesisOperation(REAL_GENESIS.operation),
          cid: yield* cidOfOperation(REAL_GENESIS.operation),
        };
      }),
    );

    expect(derived.did).toBe(REAL_GENESIS.did);
    expect(derived.cid).toBe(REAL_GENESIS.cid);
  });

  it('links a real chain: each prev is the previous operation’s CID', async () => {
    const [genesis, next] = REAL_CHAIN;

    const derived = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          genesisCid: yield* cidOfOperation(genesis.operation),
          nextCid: yield* cidOfOperation(next.operation),
        };
      }),
    );

    expect(derived.genesisCid).toBe(genesis.cid);
    expect(derived.nextCid).toBe(next.cid);
    expect(next.operation.prev).toBe(genesis.cid);
  });

  it('reads a secp256k1 operation’s shape, and verifies its real signature', async () => {
    // The keys are a real account's and are not P-256: reading the *shape* is
    // what a destination does before it forwards an operation, and it must not
    // refuse a curve this build never minted.
    const read = await Effect.runPromise(
      validateOperation(REAL_GENESIS.operation),
    );
    expect(read.type).toBe('plc_operation');
    if (read.type !== 'plc_operation') {
      throw new Error('a validated plc_operation came back a tombstone');
    }
    expect(
      read.rotationKeys.every((key) => key.startsWith('did:key:zQ3sh')),
    ).toBe(true);

    // And the signature over it is one this build can check. The fixture is an
    // operation plc.directory itself accepted, so a "yes" here is the same
    // answer the network gave - on the curve none of our own accounts use, which
    // is why it took a second implementation of ECDSA to answer it.
    const signedBy = await Effect.runPromise(
      verifyOperationSignature({
        operation: REAL_GENESIS.operation,
        allowedKeys: read.rotationKeys,
      }),
    );
    expect(signedBy).toBe(read.rotationKeys[1]);
  });
});

describe('minting', () => {
  it('mints an account whose genesis operation validates and renders', async () => {
    const account = await Effect.runPromise(
      makeAccount({
        handle: 'alice.example.com',
        serviceEndpoint: 'pds.example.com',
      }),
    );

    expect(account.did).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(account.operation.prev).toBeNull();

    // The signature must be low-S: a high-S one would give the operation a
    // second CID, and the real directory would reject it.
    expect(
      isSignatureNormalized(base64urlDecode(account.operation.sig ?? '')),
    ).toBe(true);

    const document = renderDocument({
      did: account.did,
      operation: account.operation,
    });

    expect(document.id).toBe(account.did);
    expect(document.alsoKnownAs).toEqual(['at://alice.example.com']);
    expect(document.verificationMethod).toEqual([
      {
        id: `${account.did}#atproto`,
        type: 'Multikey',
        controller: account.did,
        publicKeyMultibase: account.signingKey.slice('did:key:'.length),
      },
    ]);
    // The endpoint is normalised to a URL: PLC's own formatter does the same.
    expect(document.service).toEqual([
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.example.com',
      },
    ]);
  });

  it('publishes a dedicated KEM key beside `atproto` in the genesis operation', async () => {
    const minted = await Effect.runPromise(
      Effect.gen(function* () {
        const rotation = yield* generateES256KeyPair();
        const signing = yield* generateES256KeyPair();
        const kem = yield* generateES256KeyPair();
        const rotationKey = yield* createDIDKey(rotation.publicKey);
        const signingKey = yield* createDIDKey(signing.publicKey);
        const kemKey = yield* createDIDKey(kem.publicKey);

        const { did, operation } = yield* createAccount({
          handle: 'alice.example.com',
          serviceEndpoint: 'https://pds.example.com',
          rotationKeys: [rotationKey],
          signingKey,
          kemKey,
          rotationPrivateKey: rotation.privateKey,
        });
        return { did, operation, signingKey, kemKey };
      }),
    );

    // The key is a did:key the directory accepts, so the operation still names
    // its own DID — the KEM key is part of the hashed bytes.
    await Effect.runPromise(
      validateGenesisOperation({
        did: minted.did,
        operation: minted.operation,
      }),
    );

    expect(minted.operation.verificationMethods).toEqual({
      atproto: minted.signingKey,
      atproto_kem: minted.kemKey,
    });
    // A dedicated pair, never the signing key reused.
    expect(minted.kemKey).not.toBe(minted.signingKey);

    // And the document a resolver builds carries it as its own method, in the
    // multikey encoding atproto writes.
    const document = renderDocument({
      did: minted.did,
      operation: minted.operation,
    });
    expect(document.verificationMethod).toEqual([
      {
        id: `${minted.did}#atproto`,
        type: 'Multikey',
        controller: minted.did,
        publicKeyMultibase: minted.signingKey.slice('did:key:'.length),
      },
      {
        id: `${minted.did}#atproto_kem`,
        type: 'Multikey',
        controller: minted.did,
        publicKeyMultibase: minted.kemKey.slice('did:key:'.length),
      },
    ]);
  });

  it('rejects a genesis operation that does not name the DID it was submitted for', async () => {
    const account = await Effect.runPromise(
      makeAccount({
        handle: 'alice.example.com',
        serviceEndpoint: 'https://pds.example.com',
      }),
    );

    await expect(
      Effect.runPromise(
        validateGenesisOperation({
          did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
          operation: account.operation,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidPlcOperationError);
  });

  it('rejects a tampered operation, because the signature covers the bytes', async () => {
    const account = await Effect.runPromise(
      makeAccount({
        handle: 'alice.example.com',
        serviceEndpoint: 'https://pds.example.com',
      }),
    );

    await expect(
      Effect.runPromise(
        verifyOperationSignature({
          operation: {
            ...account.operation,
            alsoKnownAs: ['at://mallory.example.com'],
          },
          allowedKeys: [account.rotationKey],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidPlcSignatureError);
  });
});

describe('rotation and tombstone', () => {
  it('authorizes a plain append with the previous operation’s rotation keys', async () => {
    const account = await Effect.runPromise(
      makeAccount({
        handle: 'alice.example.com',
        serviceEndpoint: 'https://pds.example.com',
      }),
    );

    const keys = await Effect.runPromise(
      authorizingKeys({ previous: account.operation, nullifying: [] }),
    );

    expect(keys).toEqual([account.rotationKey]);
  });

  it('narrows a recovery to the keys that outrank the signer being undone', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* generateES256KeyPair();
        const session = yield* generateES256KeyPair();
        const rootKey = yield* createDIDKey(root.publicKey);
        const sessionKey = yield* createDIDKey(session.publicKey);

        // The genesis declares both keys, most authoritative first, and is
        // signed by the root key.
        const { operation: genesis } = yield* createAccount({
          handle: 'alice.example.com',
          serviceEndpoint: 'https://pds.example.com',
          rotationKeys: [rootKey, sessionKey],
          signingKey: sessionKey,
          rotationPrivateKey: root.privateKey,
        });

        // A fork signed by the LESS authoritative key, as if it had leaked.
        const fork = yield* signOperation({
          operation: buildOperation({
            alsoKnownAs: ['mallory.example.com'],
            serviceEndpoint: 'https://pds.example.com',
            rotationKeys: [rootKey, sessionKey],
            signingKey: sessionKey,
            prev: yield* cidOfOperation(genesis),
          }),
          privateKey: session.privateKey,
        });

        return {
          recoveryKeys: yield* authorizingKeys({
            previous: genesis,
            nullifying: [fork],
          }),
          rootKey,
          sessionKey,
        };
      }),
    );

    // Only the key that outranks the fork's signer may sign the recovery.
    expect(result.recoveryKeys).toEqual([result.rootKey]);
    expect(result.recoveryKeys).not.toContain(result.sessionKey);
  });

  it('tombstones an account, after which no key can extend it', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const account = yield* makeAccount({
          handle: 'alice.example.com',
          serviceEndpoint: 'https://pds.example.com',
        });
        return {
          tombstone: yield* createTombstone({
            previous: account.operation,
            signer: account.rotation.privateKey,
          }),
          genesisCid: yield* cidOfOperation(account.operation),
        };
      }),
    );

    expect(result.tombstone.type).toBe('plc_tombstone');
    expect(result.tombstone.prev).toBe(result.genesisCid);

    await expect(
      Effect.runPromise(
        authorizingKeys({ previous: result.tombstone, nullifying: [] }),
      ),
    ).rejects.toBeInstanceOf(InvalidPlcOperationError);
  });

  it('rejects a rotation key set that is empty, too large, or repeats a key', async () => {
    const account = await Effect.runPromise(
      makeAccount({
        handle: 'alice.example.com',
        serviceEndpoint: 'https://pds.example.com',
      }),
    );
    const key = account.rotationKey;

    const invalid = [
      { ...account.operation, rotationKeys: [] },
      {
        ...account.operation,
        rotationKeys: Array.from({ length: 6 }, () => key),
      },
      { ...account.operation, rotationKeys: [key, key] },
    ];

    const results = await Effect.runPromise(
      Effect.forEach(invalid, (operation) =>
        Effect.result(validateOperation(operation)),
      ),
    );

    for (const result of results) {
      expect(result._tag).toBe('Failure');
    }
  });
});
