import {
  DirectoryAccountsApi,
  directoryAccountsApiHandlers,
} from './directory-accounts-api.js';
import { Effect, Fiber, Layer } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServer } from 'effect/http';
import {
  PlcDirectoryApi,
  plcDirectoryApiHandlers,
} from './plc-directory-api.js';
import { createDIDKey, generateES256KeyPair } from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import {
  didDocumentTransportLayer,
  resolvePlcDocument,
} from './did-resolution.js';
import { DirectoryAccounts } from './directory-accounts.js';
import { HttpApiBuilder } from 'effect/http-api';
import { NodeHttpServer } from '@effect/platform-node';
import { TEST_RECOVERY_ROTATION_KEY } from './recovery-key.js';
import { createServer } from 'node:http';
import { didOperationLogLayer } from './did-operation-log.js';
import { directoryAccountsClientLayer } from './directory-accounts-client.js';
import { directoryAccountsLayer } from './directory-accounts.js';
import { rotationKeyStoreLayer } from './rotation-keys.js';

/**
 * The directory over a socket: an account minted through the custodial surface,
 * then resolved through the compatible one.
 *
 * That second half is the assertion that matters. The custody has to append its
 * genesis to the *same* log the resolver reads - if the layers were built twice,
 * a freshly minted account would resolve as an unknown DID, and the network
 * would mint identifiers nobody could look up.
 */

const Log = didOperationLogLayer;
const Keys = rotationKeyStoreLayer;
const Custody = directoryAccountsLayer({
  recoveryRotationKey: TEST_RECOVERY_ROTATION_KEY,
}).pipe(Layer.provide(Layer.mergeAll(Log, Keys)));

const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(PlcDirectoryApi, {
    openapiPath: '/openapi.json',
  }).pipe(Layer.provide(plcDirectoryApiHandlers)),
  HttpApiBuilder.layer(DirectoryAccountsApi, {
    openapiPath: '/accounts/openapi.json',
  }).pipe(Layer.provide(directoryAccountsApiHandlers)),
);

describe('the directory accounts client', () => {
  it('mints an account, and the resolver finds what it minted', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const address = (yield* HttpServer.HttpServer).address;
        if (!('port' in address)) {
          return yield* Effect.die('the directory is not listening on a port');
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const serving = yield* Effect.forkScoped(
          Layer.launch(HttpRouter.serve(Routes)),
        );
        yield* Effect.sleep('50 millis');

        // A real `did:key`: the operation model has to be able to encode it, so
        // a made-up string is a 400 waiting to happen.
        const signingKey = yield* createDIDKey(
          (yield* generateES256KeyPair()).publicKey,
        );

        // The client under test, pointed at the directory we just served.
        const minted = yield* Effect.gen(function* () {
          const accounts = yield* DirectoryAccounts;
          return yield* accounts.create({
            handle: 'alice.mini-atmosphere.test',
            serviceEndpoint: 'http://localhost:2583',
            signingKey,
          });
        }).pipe(Effect.provide(directoryAccountsClientLayer({ baseUrl })));

        // And the same account, resolved through the plc.directory-shaped half.
        const document = yield* resolvePlcDocument(minted.did).pipe(
          Effect.provide(didDocumentTransportLayer(baseUrl)),
        );

        yield* Fiber.interrupt(serving);

        return { minted, document };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Log,
            Keys,
            Custody,
            FetchHttpClient.layer,
            NodeHttpServer.layer(createServer, { port: 0 }),
          ),
        ),
        Effect.scoped,
      ),
    );

    expect(result.minted.did.startsWith('did:plc:')).toBe(true);
    // The genesis is a signed operation, as the split requires.
    expect(result.minted.operation.sig).toBeDefined();
    expect(result.document.id).toBe(result.minted.did);
  }, 30_000);
});
