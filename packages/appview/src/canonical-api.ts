import { Effect, Schema } from 'effect';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';
import { CanonicalStore } from './canonical-store.js';

/**
 * The AppView's canonical read surface: a record by URI, and a collection page.
 *
 * `GET /xrpc/app.effects.getRecord?uri=…` answers with the stored envelope
 * `{ uri, cid, value }`, or a 404 when the URI is unknown.
 * `GET /xrpc/app.effects.listRecords?collection=…&limit=…&cursor=…` answers with
 * `{ records, cursor? }`, the paging shape the PDS serves: the cursor is the
 * last `rkey` of the page, exclusive on the next request.
 *
 * Neither endpoint is gated, deliberately. Everything in the canonical store
 * arrived over the public firehose - a permissioned write never reaches it - so
 * a canonical read is a read of public data, and gating it would pretend to a
 * privacy the store does not hold. That is the difference from `appview-api.ts`:
 * there the backlinks endpoint *is* gated, because a backlink can point at a
 * private subject whose visibility only a grant can establish.
 *
 * `listRecords` is collection-scoped across repositories: it lists one
 * collection's records in `rkey` order no matter which repo holds them. It is
 * not a repo-scoped read - that would need a `repo` filter the store does not
 * have yet.
 */

const RecordEnvelopeSchema = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  // The value is JSON in the store already, so it goes out as it arrived.
  value: Schema.Json,
});

const ListResultSchema = Schema.Struct({
  records: Schema.Array(RecordEnvelopeSchema),
  cursor: Schema.optionalKey(Schema.String),
});

export class CanonicalApiGroup extends HttpApiGroup.make('canonical').add(
  HttpApiEndpoint.get('getRecord', '/xrpc/app.effects.getRecord', {
    query: { uri: Schema.String },
    success: RecordEnvelopeSchema,
    error: [HttpApiError.NotFound],
  }),
  HttpApiEndpoint.get('listRecords', '/xrpc/app.effects.listRecords', {
    query: {
      collection: Schema.String,
      limit: Schema.optionalKey(Schema.FiniteFromString),
      cursor: Schema.optionalKey(Schema.String),
    },
    success: ListResultSchema,
  }),
) {}

export class CanonicalApi extends HttpApi.make('canonical').add(
  CanonicalApiGroup,
) {}

/**
 * The page size a request gets when it does not ask for one, kept here as well
 * as in the store because the endpoint asks for one more than it serves.
 */
const DEFAULT_LIST_LIMIT = 50;

/** The `rkey` of an AT-URI: its last path segment. */
const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

/**
 * The handlers over an injected store, so a host supplies it and an in-memory
 * or durable one routes the same.
 */
export const canonicalApiHandlers = HttpApiBuilder.group(
  CanonicalApi,
  'canonical',
  (handlers) =>
    handlers.handleAll({
      getRecord: ({ query }) =>
        Effect.gen(function* () {
          const store = yield* CanonicalStore;
          const record = yield* store.get(query.uri);
          if (record === undefined) {
            return yield* Effect.fail(new HttpApiError.NotFound());
          }

          return record;
        }).pipe(Effect.withSpan('appview.canonical.getRecord')),

      listRecords: ({ query }) =>
        Effect.gen(function* () {
          const store = yield* CanonicalStore;
          const limit = query.limit ?? DEFAULT_LIST_LIMIT;

          // The store's cursor is always the last rkey of the page it returns,
          // so on the final page it would be a cursor that leads nowhere. Ask
          // for one more than the page and keep the cursor only when a record
          // was actually held back.
          const page = yield* store.list({
            collection: query.collection,
            cursor: query.cursor,
            limit: limit + 1,
          });
          const records = page.records.slice(0, limit);
          const last = records[records.length - 1];

          return {
            records,
            ...(page.records.length > limit && last !== undefined
              ? { cursor: rkeyOf(last.uri) }
              : {}),
          };
        }).pipe(Effect.withSpan('appview.canonical.listRecords')),
    }),
);
