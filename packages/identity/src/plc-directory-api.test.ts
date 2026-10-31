import { Effect, Layer, Schema } from 'effect';
import { type KeyPair, createDIDKey, generateES256KeyPair } from '@eoa/crypto';
import {
  PlcDirectoryApi,
  plcDirectoryApiHandlers,
} from './plc-directory-api.js';
import {
  type PlcSignedOperation,
  PlcSignedOperationSchema,
  buildOperation,
  cidOfOperation,
  createAccount,
  createTombstone,
  didOfGenesisOperation,
  signOperation,
} from './plc-operation.js';
import { describe, expect, it } from 'vitest';
import { HttpApiTest } from 'effect/http-api';
import { HttpServer } from 'effect/http';
import { didOperationLogLayer } from './did-operation-log.js';

/**
 * The handlers over an in-memory log, wired to the typed client exactly as a
 * real server wires them - same routing, same schema decoding - without a port,
 * a socket or a database.
 */
const TestLayer = Layer.mergeAll(
  plcDirectoryApiHandlers.pipe(Layer.provide(didOperationLogLayer)),
  HttpServer.layerServices,
);

const makeClient = HttpApiTest.groups(PlcDirectoryApi, ['directory']);

/** A P-256 account minted by us, not yet submitted. */
const makeAccount = () =>
  Effect.gen(function* () {
    const rotation = yield* generateES256KeyPair();
    const signing = yield* generateES256KeyPair();
    const rotationKey = yield* createDIDKey(rotation.publicKey);
    const signingKey = yield* createDIDKey(signing.publicKey);

    const { did, operation } = yield* createAccount({
      handle: 'alice.example.com',
      serviceEndpoint: 'pds.example.com',
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

describe('the PLC directory surface', () => {
  it('serves a document, state and audit log for a submitted genesis', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeClient;
        const account = yield* makeAccount();

        yield* client.directory.submit({
          params: { did: account.did },
          payload: account.operation,
        });

        return {
          account,
          document: yield* client.directory.document({
            params: { did: account.did },
          }),
          data: yield* client.directory.data({
            params: { did: account.did },
          }),
          audit: yield* client.directory.auditLog({
            params: { did: account.did },
          }),
        };
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );

    expect(result.document.id).toBe(result.account.did);
    expect(result.document.alsoKnownAs).toEqual(['at://alice.example.com']);
    // `#atproto` and Multikey are what a real resolver reads.
    expect(result.document.verificationMethod[0]?.id).toBe(
      `${result.account.did}#atproto`,
    );
    expect(result.document.verificationMethod[0]?.type).toBe('Multikey');
    expect(result.document.verificationMethod[0]?.publicKeyMultibase).toBe(
      result.account.signingKey.slice('did:key:'.length),
    );
    expect(result.document.service[0]?.serviceEndpoint).toBe(
      'https://pds.example.com',
    );

    expect(result.data.did).toBe(result.account.did);
    expect(result.data.rotationKeys).toEqual([result.account.rotationKey]);

    expect(result.audit).toHaveLength(1);
    expect(result.audit[0]?.nullified).toBe(false);
    expect(result.audit[0]?.seq).toBe(1);
    expect(result.audit[0]?.cid).toBe(
      await Effect.runPromise(cidOfOperation(result.account.operation)),
    );
  });

  it('serves a 404 for a DID it has never seen', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeClient;
        // A real DID that was never submitted, so the request is well-formed.
        const { did } = yield* makeAccount();

        return {
          document: yield* Effect.flip(
            client.directory.document({ params: { did } }),
          ),
          data: yield* Effect.flip(client.directory.data({ params: { did } })),
          audit: yield* Effect.flip(
            client.directory.auditLog({ params: { did } }),
          ),
        };
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );

    expect(result.document._tag).toBe('NotFound');
    expect(result.data._tag).toBe('NotFound');
    expect(result.audit._tag).toBe('NotFound');
  });

  it('rejects a duplicate submission with a conflict', async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeClient;
        const account = yield* makeAccount();
        const submit = () =>
          client.directory.submit({
            params: { did: account.did },
            payload: account.operation,
          });

        yield* submit();
        return yield* Effect.flip(submit());
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );

    expect(error._tag).toBe('Conflict');
  });

  it('rejects an operation submitted for a DID it does not name', async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeClient;
        const alice = yield* makeAccount();
        const bob = yield* makeAccount();

        return yield* Effect.flip(
          client.directory.submit({
            params: { did: alice.did },
            payload: bob.operation,
          }),
        );
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );

    expect(error._tag).toBe('BadRequest');
  });

  it('rejects a tampered operation, because the signature covers the bytes', async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeClient;
        const account = yield* makeAccount();

        return yield* Effect.flip(
          client.directory.submit({
            params: { did: account.did },
            payload: {
              ...account.operation,
              alsoKnownAs: ['at://mallory.example.com'],
            },
          }),
        );
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );

    expect(error._tag).toBe('BadRequest');
  });

  it('applies an update, then retires the DID with a tombstone', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeClient;
        const account = yield* makeAccount();
        yield* client.directory.submit({
          params: { did: account.did },
          payload: account.operation,
        });

        const update = yield* makeUpdate({
          previous: account.operation,
          rotation: account.rotation,
          rotationKey: account.rotationKey,
          handle: 'alice2.example.com',
        });
        yield* client.directory.submit({
          params: { did: account.did },
          payload: update,
        });
        const rotated = yield* client.directory.document({
          params: { did: account.did },
        });

        const tombstone = yield* createTombstone({
          previous: update,
          signer: account.rotation.privateKey,
        });
        yield* client.directory.submit({
          params: { did: account.did },
          payload: tombstone,
        });

        return {
          rotated,
          afterTombstone: yield* Effect.flip(
            client.directory.document({ params: { did: account.did } }),
          ),
          audit: yield* client.directory.auditLog({
            params: { did: account.did },
          }),
        };
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );

    expect(result.rotated.alsoKnownAs).toEqual(['at://alice2.example.com']);
    expect(result.rotated.service[0]?.serviceEndpoint).toBe(
      'https://pds2.example.com',
    );
    // A tombstoned DID answers reads with a 404 but keeps its audit history.
    expect(result.afterTombstone._tag).toBe('NotFound');
    expect(result.audit).toHaveLength(3);
    expect(result.audit[2]?.operation.type).toBe('plc_tombstone');
  });

  it('round-trips a real plc.directory operation through the wire schema', async () => {
    // The wire schema and the operation model are one definition, so a real
    // operation decoded from JSON must still derive its real DID and CID.
    const wire = {
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
    };

    const decoded = await Effect.runPromise(
      Effect.gen(function* () {
        const operation = yield* Schema.decodeUnknownEffect(
          PlcSignedOperationSchema,
        )(wire);
        return {
          did: yield* didOfGenesisOperation(operation),
          cid: yield* cidOfOperation(operation),
        };
      }),
    );

    expect(decoded.did).toBe('did:plc:fmk3w5fb5dtrhwrvupnnubrm');
    expect(decoded.cid).toBe(
      'bafyreiblcw5xjipi44j5unnd3lnamlfxu6jay5pp42dl534omgwzgrny4y',
    );
  });

  it('rejects a payload that is not an operation at all', () => {
    // The schema is the trust boundary: a malformed submission never reaches
    // the operation model, or the log.
    expect(() =>
      Schema.decodeUnknownSync(PlcSignedOperationSchema)({ bogus: true }),
    ).toThrow();
  });
});
