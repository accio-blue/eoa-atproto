import { Effect, Option, Result, Schema } from 'effect';
import { type IdentityResolver, resolveServiceEndpoint } from '@eoa/identity';
import { type PdsConfig, bearer, invalid, unauthorized } from './pds.js';
import { SPACE_METHODS } from '@eoa/space-host';
import { type XrpcServer } from '@eoa/xrpc-server';
import { proofOfControl } from './proof.js';
import { spaceOf } from './space.js';

/**
 * The **mutuals oracle**: a managed space whose audience is its follow graph, answered by the host
 * itself (`mqu7`, proposal `0016`'s follower-gating).
 *
 * The authority names its own host as the space's `managingApp` (`<host did>#atproto_pds`), and
 * `managing-app.ts` asks it `com.atproto.managedspace.checkUserAccess` on every read. Here the host
 * answers from `app.bsky.graph.follow` — the authority follows the user, and the user follows the
 * authority — so no member list exists and nothing has to be synced when someone follows.
 *
 * **Every failure is a no.** A DID that does not resolve, a PDS that does not answer, a record that
 * does not parse, a graph too big to page through: none of them is "yes" and none of them is an
 * error answer, because the spec makes a host's failure to decide a refusal. Only the *token* can
 * produce a 401, and only about the token — never about the graph.
 */

/** The collection a follow lives in. */
const FOLLOW_COLLECTION = 'app.bsky.graph.follow';

const LIST_RECORDS = 'com.atproto.repo.listRecords';

/**
 * How many pages of a follow graph are read before the graph is refused: a graph too big to read is
 * a refusal, not a hang, and `askManagingApp` is bounded at two seconds.
 */
export const FOLLOW_PAGE_LIMIT = 20;

/** The page size asked of `listRecords`: the host's own ceiling, so one page is as big as it gets. */
const FOLLOW_PAGE_SIZE = 100;

/** A follow graph that could not be read, and why. `mutualRule` turns every one of these into a no. */
export class FollowsUnreadable extends Schema.TaggedError<FollowsUnreadable>()(
  'FollowsUnreadable',
  { reason: Schema.String },
) {}

const unreadable = (reason: string) => new FollowsUnreadable({ reason });

/** What `listRecords` answers, as far as a follow graph reads it. Other fields are not ours. */
const LIST_RECORDS_ANSWER = Schema.Struct({
  records: Schema.Array(
    Schema.Struct({
      value: Schema.Struct({ subject: Schema.String }),
    }),
  ),
  cursor: Schema.optional(Schema.String),
});

/**
 * The follow graph of one DID, read from its own PDS over HTTP.
 *
 * **Network-only, no local branch and no cache.** A DID hosted here is read exactly the way a
 * remote one is, so there is one path and one set of bugs. The cost is O(follows) per check, which
 * is fine for a prototype and wrong for an account with thousands of follows: that account will
 * time out against the ask's bound and be refused. The fix is a follow index fed by the stream
 * (`cm39`), not a cache in front of this.
 */
export const liveFollows = (params: {
  readonly did: string;
  readonly identity: IdentityResolver;
  readonly fetchImpl?: typeof fetch | undefined;
}): Effect.Effect<ReadonlySet<string>, FollowsUnreadable> =>
  Effect.gen(function* () {
    const resolved = yield* resolveServiceEndpoint({
      identifier: `${params.did}#atproto_pds`,
      resolver: params.identity,
    }).pipe(
      Effect.mapError((error) =>
        unreadable(`${params.did} has no PDS to read: ${error.reason}`),
      ),
    );
    const base = resolved.endpoint.replace(/\/+$/u, '');
    const ask = params.fetchImpl ?? fetch;
    const subjects = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < FOLLOW_PAGE_LIMIT; page += 1) {
      const url = new URL(`${base}/xrpc/${LIST_RECORDS}`);
      url.searchParams.set('repo', params.did);
      url.searchParams.set('collection', FOLLOW_COLLECTION);
      url.searchParams.set('limit', String(FOLLOW_PAGE_SIZE));
      if (cursor !== undefined) {
        url.searchParams.set('cursor', cursor);
      }
      const response = yield* Effect.tryPromise({
        try: () => ask(url),
        catch: (cause) =>
          unreadable(
            `the follow graph of ${params.did} could not be reached: ${String(cause)}`,
          ),
      });
      if (response.status !== 200) {
        return yield* Effect.fail(
          unreadable(
            `the follow graph of ${params.did} answered ${response.status}`,
          ),
        );
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          unreadable(`the follow graph of ${params.did} did not answer JSON`),
      });
      const decoded = Schema.decodeUnknownOption(LIST_RECORDS_ANSWER)(body);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          unreadable(
            `the follow graph of ${params.did} is not a listRecords answer`,
          ),
        );
      }
      for (const record of decoded.value.records) {
        subjects.add(record.value.subject);
      }
      const next = decoded.value.cursor;
      if (next === undefined || next === '') {
        return subjects;
      }
      cursor = next;
    }
    return yield* Effect.fail(
      unreadable(
        `the follow graph of ${params.did} is longer than ${FOLLOW_PAGE_LIMIT} pages`,
      ),
    );
  });

/** How one DID's follow graph is read. Injected so the rule is testable without a network. */
export type FollowsReader = (
  did: string,
) => Effect.Effect<ReadonlySet<string>, FollowsUnreadable>;

/**
 * The rule: a **mutual** is reciprocal.
 *
 * The authority always passes — it is the authority of its own space, and asking it about itself is
 * a question with one answer. Otherwise the authority's follows must name the user **and** the
 * user's must name the authority. A read that fails is `false`, and the authority's read that
 * already says no is the end of it: the second read is not worth doing.
 */
export const mutualRule = (params: {
  readonly authority: string;
  readonly user: string;
  readonly follows: FollowsReader;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (params.authority === params.user) {
      return true;
    }
    const authorityRead = yield* Effect.result(
      params.follows(params.authority),
    );
    if (
      Result.isFailure(authorityRead) ||
      !authorityRead.success.has(params.user)
    ) {
      return false;
    }
    const userRead = yield* Effect.result(params.follows(params.user));
    return Result.isSuccess(userRead) && userRead.success.has(params.authority);
  });

/** The query the managing app sends: the space, the user, and an `access` the rule does not read. */
const CHECK_INPUT = Schema.Struct({
  space: Schema.String,
  user: Schema.String,
});

/** What this route needs: who we are, and how a DID resolves to its PDS. */
export interface MutualsSurfaceDeps {
  readonly config: PdsConfig;
  readonly identity: IdentityResolver;
}

/**
 * The audiences this host answers to. Its own DID is the host; its `#atproto_pds` service is the
 * name a managed space puts in `managingApp`, and `askManagingApp` addresses the token to exactly
 * that string. Both name this host, and nothing else does.
 */
const audiencesOf = (config: PdsConfig) => [
  `${config.did}#atproto_pds`,
  config.did,
];

/**
 * `com.atproto.managedspace.checkUserAccess`, served here beside the space methods.
 *
 * The issuer is the space's **authority, parsed out of the `space` URI and never taken from the
 * token**: a token proves who signed it, not whose space it may ask about, so the token has to be
 * signed by the authority of the space it names. `proofOfControl` does the rest — this host is the
 * audience and this method is the `lxm`, so a token minted to call something else is refused.
 */
export const registerMutualMethods = (
  server: XrpcServer,
  deps: MutualsSurfaceDeps,
) => {
  const proved = (params: {
    readonly did: string;
    readonly token: string;
    readonly now: number;
  }) =>
    Effect.gen(function* () {
      let reason = 'the token names no audience this host answers to';
      for (const audience of audiencesOf(deps.config)) {
        const attempt = yield* Effect.result(
          proofOfControl({
            did: params.did,
            token: params.token,
            audience,
            lxm: SPACE_METHODS.checkUserAccess,
            plcDirectoryUrl: deps.config.plcDirectoryUrl,
            fetchDocument: deps.config.fetchDocument,
            now: params.now,
          }),
        );
        if (Result.isSuccess(attempt)) {
          return attempt.success;
        }
        reason = attempt.failure.reason;
      }
      return yield* Effect.fail(unauthorized(reason));
    });

  server.method(SPACE_METHODS.checkUserAccess, {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(CHECK_INPUT)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          invalid('checkUserAccess needs a space and a user'),
        );
      }
      const parsed = spaceOf(decoded.value.space);
      if (parsed === undefined) {
        return yield* Effect.fail(
          invalid(`${decoded.value.space} is not a space address`),
        );
      }
      const token = bearer(ctx);
      if (token === undefined) {
        return yield* Effect.fail(
          unauthorized('checkUserAccess is asked with a service-auth token'),
        );
      }
      // The authority is the space's, not the token's: a yes here is about the graph of whoever
      // owns the space, so only that authority may ask. Any other issuer fails `proofOfControl`.
      yield* proved({
        did: parsed.authority,
        token,
        now: Date.now(),
      });
      const authorized = yield* mutualRule({
        authority: parsed.authority,
        user: decoded.value.user,
        follows: (did) => liveFollows({ did, identity: deps.identity }),
      });
      return { authorized };
    }),
  );
};
