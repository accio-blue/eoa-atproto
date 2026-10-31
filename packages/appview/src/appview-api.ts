import { Effect, Schema } from 'effect';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from 'effect/http-api';
import { BacklinkLookup } from './lookup.js';

/**
 * The AppView's XRPC surface: one read, "who references this subject?".
 *
 * `GET /xrpc/app.effects.backlinks` carries the subject (`target`) and the
 * visibility gate's facts as query parameters. The facts are handed in on the
 * wire only because the space host that owns grants (Tier 0.3) does not exist
 * yet: when it does, `viewer` becomes a DID and the gate's facts are resolved
 * from that viewer's grants instead of being supplied by the caller. There is
 * no `viewer` parameter yet - accepting one and echoing it unused would read as
 * if it changed the answer when nothing consults it.
 */

/** The gate's answer: the decision, and the sources only a `visible` one has. */
const BacklinksResult = Schema.Struct({
  decision: Schema.Literals(['visible', 'hidden', 'none']),
  sources: Schema.Array(Schema.String),
});

export class BacklinksApiGroup extends HttpApiGroup.make('backlinks').add(
  HttpApiEndpoint.get('backlinks', '/xrpc/app.effects.backlinks', {
    // Every optional fact defaults fail-closed in the handler: an absent
    // `visibility` or `grant` is `"none"`, an absent boolean is false.
    query: {
      target: Schema.String,
      visibility: Schema.optionalKey(Schema.String),
      grant: Schema.optionalKey(Schema.String),
      subjectMatchesViewer: Schema.optionalKey(Schema.Boolean),
      selectorOk: Schema.optionalKey(Schema.Boolean),
      expired: Schema.optionalKey(Schema.Boolean),
    },
    success: BacklinksResult,
  }),
) {}

export class AppviewApi extends HttpApi.make('appview').add(
  BacklinksApiGroup,
) {}

/**
 * The handler over an injected lookup, so a host supplies the store and an
 * in-memory or durable one routes the same. The gate's facts default to the
 * fail-closed values an absent parameter has to mean.
 */
export const appviewApiHandlers = HttpApiBuilder.group(
  AppviewApi,
  'backlinks',
  (handlers) =>
    handlers.handleAll({
      backlinks: ({ query }) =>
        Effect.gen(function* () {
          const lookup = yield* BacklinkLookup;

          return yield* lookup.backlinks({
            target: query.target,
            visibility: query.visibility ?? 'none',
            grant: query.grant ?? 'none',
            subjectMatchesViewer: query.subjectMatchesViewer ?? false,
            selectorOk: query.selectorOk ?? false,
            expired: query.expired ?? false,
          });
        }).pipe(Effect.withSpan('appview.backlinks')),
    }),
);
