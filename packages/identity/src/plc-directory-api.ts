import { DidOperationLog, IndexedEntrySchema } from './did-operation-log.js';
import { Effect, Schema } from 'effect';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from 'effect/http-api';
import {
  PlcDataSchema,
  PlcDidDocumentSchema,
  PlcSignedOperationSchema,
} from './plc-operation.js';
import { DID } from '@eoa/core';

/**
 * The directory's HTTP surface: the shape `plc.directory` serves, so that
 * existing atproto services resolve our identifiers unchanged -
 * `@atproto/identity` given a `plcUrl`, or Slingshot with `--plc-directory`.
 * No fork, no edge identifier: the identifiers really are `did:plc`.
 *
 * Only the endpoints a resolving consumer needs are here. `/export` is
 * deliberately absent (mirrors want it, but it needs a directory-wide
 * sequence), as are `/log` and `/log/last`.
 *
 * `POST /<did>` is the trust boundary: the payload is decoded by the operation
 * schema, so a malformed submission is a 400 before the operation model - or
 * the log - ever sees it. That is why the API is defined here and not at the
 * transport, and why a submission and a response can share one schema.
 *
 * Serving it lives in `apps/directory`: definitions stay client-safe.
 */

export class PlcDirectoryApiGroup extends HttpApiGroup.make('directory')
  .add(
    HttpApiEndpoint.get('document', '/:did', {
      params: { did: DID },
      success: PlcDidDocumentSchema,
      error: HttpApiError.NotFound,
    }),
    HttpApiEndpoint.get('data', '/:did/data', {
      params: { did: DID },
      success: PlcDataSchema,
      error: HttpApiError.NotFound,
    }),
    HttpApiEndpoint.get('auditLog', '/:did/log/audit', {
      params: { did: DID },
      success: Schema.Array(IndexedEntrySchema),
      error: HttpApiError.NotFound,
    }),
    HttpApiEndpoint.post('submit', '/:did', {
      params: { did: DID },
      payload: PlcSignedOperationSchema,
      success: HttpApiSchema.NoContent,
      error: [HttpApiError.BadRequest, HttpApiError.Conflict],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'PLC directory',
      description: 'Resolves did:plc identifiers, resolved by the same rules.',
    }),
  ) {}

export class PlcDirectoryApi extends HttpApi.make('plc-directory')
  .add(PlcDirectoryApiGroup)
  .annotateMerge(OpenApi.annotations({ title: 'PLC directory' })) {}

const notFound = () => Effect.fail(new HttpApiError.NotFound());

/**
 * The handlers over an injected log, so a host supplies the storage and tests
 * supply the in-memory one.
 */
export const plcDirectoryApiHandlers = HttpApiBuilder.group(
  PlcDirectoryApi,
  'directory',
  Effect.fn(function* (handlers) {
    const log = yield* DidOperationLog;

    return handlers.handleAll({
      document: ({ params }) =>
        log.resolve(params.did).pipe(
          Effect.catchTags({
            UnknownDidError: notFound,
            TombstonedDidError: notFound,
          }),
        ),
      data: ({ params }) =>
        log.resolveData(params.did).pipe(
          Effect.catchTags({
            UnknownDidError: notFound,
            TombstonedDidError: notFound,
          }),
        ),
      // An empty log is an unknown DID: the directory cannot tell them apart.
      auditLog: ({ params }) =>
        log.history(params.did).pipe(
          Effect.filterOrFail(
            (entries) => entries.length > 0,
            () => new HttpApiError.NotFound(),
          ),
        ),
      submit: ({ params, payload }) =>
        log.append({ did: params.did, operation: payload }).pipe(
          Effect.asVoid,
          // A key or hashing failure is a server fault, not a bad request.
          Effect.catchTag('CryptoError', (error) => Effect.die(error)),
          Effect.catchTags({
            DuplicateOperationError: () =>
              Effect.fail(new HttpApiError.Conflict()),
            MisorderedOperationError: () =>
              Effect.fail(new HttpApiError.BadRequest()),
            InvalidPlcOperationError: () =>
              Effect.fail(new HttpApiError.BadRequest()),
            InvalidPlcSignatureError: () =>
              Effect.fail(new HttpApiError.BadRequest()),
          }),
        ),
    });
  }),
);
