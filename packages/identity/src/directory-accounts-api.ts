import { Effect, Schema } from 'effect';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  OpenApi,
} from 'effect/http-api';
import { DID } from '@eoa/core';
import { DirectoryAccounts } from './directory-accounts.js';
import { PlcSignedOperationSchema } from './plc-operation.js';

/**
 * The directory's custodial surface - ours, and deliberately not
 * `plc.directory`'s.
 *
 * `PlcDirectoryApi` is the compatibility seam and serves only what a resolving
 * consumer needs: resolution, and the submission of operations that are
 * *already signed*. Minting an account cannot be that, because the rotation key
 * has to be generated in custody - the directory signs the genesis and the
 * caller never sees the key. That is the split the whole arrangement rests on,
 * and it is what this endpoint exists for: without it the PDS would have to
 * keep the rotation key itself, which is the one thing it must not do.
 */

const AccountOperationSchema = Schema.Struct({
  did: DID,
  operation: PlcSignedOperationSchema,
});

export class DirectoryAccountsApiGroup extends HttpApiGroup.make(
  'accounts',
).add(
  HttpApiEndpoint.post('create', '/accounts', {
    payload: Schema.Struct({
      handle: Schema.String,
      serviceEndpoint: Schema.String,
      signingKey: Schema.String,
      /** The account's dedicated `#atproto_kem` key, when the host holds one. */
      kemKey: Schema.optionalKey(Schema.String),
    }),
    success: AccountOperationSchema,
    error: [
      HttpApiError.BadRequest,
      HttpApiError.Conflict,
      HttpApiError.InternalServerError,
    ],
  }),
) {}

export class DirectoryAccountsApi extends HttpApi.make('directory-accounts')
  .add(DirectoryAccountsApiGroup)
  .annotateMerge(OpenApi.annotations({ title: 'Directory accounts' })) {}

const conflict = () => Effect.fail(new HttpApiError.Conflict());
const internal = () => Effect.fail(new HttpApiError.InternalServerError());

/** The handlers over an injected custodian, so a host supplies the keys. */
export const directoryAccountsApiHandlers = HttpApiBuilder.group(
  DirectoryAccountsApi,
  'accounts',
  Effect.fn(function* (handlers) {
    const accounts = yield* DirectoryAccounts;

    return handlers.handleAll({
      // Signing and logging failures are ours, not the caller's: a genesis that
      // will not sign is not their fault.
      create: ({ payload }) =>
        accounts.create(payload).pipe(
          Effect.catchTags({
            DuplicateRotationKeyError: conflict,
            DirectoryRequestError: internal,
            CryptoError: internal,
            InvalidPlcOperationError: internal,
            InvalidPlcSignatureError: internal,
            DuplicateOperationError: internal,
            MisorderedOperationError: internal,
            UnknownRotationKeyError: internal,
            UnknownDidError: internal,
            TombstonedDidError: internal,
          }),
        ),
    });
  }),
);
