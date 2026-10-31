import {
  DirectoryAccounts,
  type DirectoryAccountsShape,
  DirectoryRequestError,
} from './directory-accounts.js';
import { Effect, Layer } from 'effect';
import { DirectoryAccountsApi } from './directory-accounts-api.js';
import { HttpApiClient } from 'effect/http-api';

/**
 * The directory as a PDS sees it: a client of its custodial surface.
 *
 * `create` is the operation the split needs - the rotation key is generated
 * inside the directory and never leaves it, and the PDS holds only the signing
 * key for the repository it writes. The other three operations the interface
 * names are not exposed over the wire yet, so they fail as the programming
 * errors they would be, rather than pretending to have done something.
 */
export const directoryAccountsClientLayer = (config: {
  readonly baseUrl: string;
}) =>
  Layer.effect(
    DirectoryAccounts,
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(DirectoryAccountsApi, {
        baseUrl: config.baseUrl,
      });
      const unsupported = (operation: string) =>
        Effect.die(`the directory does not serve ${operation} over HTTP yet`);

      return {
        create: (params) =>
          client.accounts.create({ payload: params }).pipe(
            // Everything the wire can say - a status, a transport - is one
            // failure to the caller: the directory did not mint.
            Effect.mapError(
              (error) => new DirectoryRequestError({ message: String(error) }),
            ),
          ),
        update: () => unsupported('an account update'),
        rotateRotationKey: () => unsupported('a rotation key change'),
        tombstone: () => unsupported('a tombstone'),
      } satisfies DirectoryAccountsShape;
    }),
  );
