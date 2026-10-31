import {
  type CanonicalRecord,
  CanonicalStore,
  type CanonicalStoreShape,
} from './canonical-store.js';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { HandleResolver, type HandleResolverShape } from './handle-resolver.js';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';
import type { Json } from 'effect/Schema';

/**
 * The AppView's hydrated reads.
 *
 * `GET /xrpc/app.bsky.feed.getPostThread?uri=…` answers with the one post the
 * URI names, hydrated into the `threadViewPost` the client decodes, or with a
 * `notFoundPost` when the store holds no such record. A miss is a 200, not a
 * 404: the client renders "post not found" from the body, and the request
 * itself succeeded.
 *
 * The thread read is deliberately shallow. `depth` and `parentHeight` are
 * accepted so the XRPC surface matches the lexicon, and then ignored:
 * assembling parents and replies needs collection scans and recursive
 * hydration this slice does not do. The thread is always the single post, with
 * no `parent` and no `replies`.
 *
 * `GET /xrpc/app.bsky.actor.getProfile?actor=…` answers with only the profile
 * fields the client reads, counting the DID's stored posts. An actor that
 * resolves to no DID, or that holds no profile record, is a 404. The client's
 * `failure()` treats a 400 as not-found, so the 404 is a fidelity gap noted
 * where the failure is raised rather than a 400 with an invented lexicon name.
 *
 * `GET /xrpc/app.bsky.feed.getAuthorFeed?actor=…` answers with the actor's
 * posts, newest first, filtered and paged in memory. The store filters by
 * collection, not by repo, so the scan is bounded and the feed is assembled
 * from one page of it.
 *
 * The reads are not gated, for the same reason the canonical reads are not:
 * the store only ever holds what arrived over the public firehose.
 */

/** The author shape a hydrated post embeds. Only the fields sky reads are
 *  modelled; extra lexicon fields would be ignored on decode anyway. */
const ProfileViewBasic = Schema.Struct({
  did: Schema.String,
  handle: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});

export const PostView = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  author: ProfileViewBasic,
  // The stored value is already JSON, so it passes through as it arrived.
  record: Schema.Json,
  indexedAt: Schema.String,
});
export type PostView = typeof PostView.Type;

/** What `app.bsky.actor.getProfile` emits. `avatar` is omitted - a stored blob
 *  ref is meaningless without a URL - and so are the counts we cannot know. */
const ProfileViewDetailed = Schema.Struct({
  did: Schema.String,
  handle: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  postsCount: Schema.optionalKey(Schema.Number),
});

/** The three tabs the client's profile screen asks for. */
const AuthorFeedFilter = Schema.Literals([
  'posts_no_replies',
  'posts_with_replies',
  'posts_with_media',
]);
type AuthorFeedFilter = typeof AuthorFeedFilter.Type;

const AuthorFeedResponse = Schema.Struct({
  feed: Schema.Array(Schema.Struct({ post: PostView })),
  cursor: Schema.optionalKey(Schema.String),
});

const ThreadViewPost = Schema.Struct({
  $type: Schema.Literal('app.bsky.feed.defs#threadViewPost'),
  post: PostView,
});

const NotFoundPost = Schema.Struct({
  $type: Schema.Literal('app.bsky.feed.defs#notFoundPost'),
  uri: Schema.String,
});

/** The union the client decodes: a hydrated post, or the honest miss. */
const GetPostThreadResponse = Schema.Struct({
  thread: Schema.Union([ThreadViewPost, NotFoundPost]),
});

const AT_URI_PREFIX = 'at://';

const POST_COLLECTION = 'app.bsky.feed.post';

const PROFILE_COLLECTION = 'app.bsky.actor.profile';

/** The page size an author feed gets when it does not ask for one. */
const DEFAULT_AUTHOR_FEED_LIMIT = 30;

/**
 * The authority, collection and rkey of `at://<authority>/<collection>/<rkey>`,
 * or `undefined` when the URI is not shaped like one. Splitting on the first
 * two slashes keeps a DID with a colon in its method (`did:web:example.com`)
 * intact rather than splitting on every colon.
 */
const parseAtUri = (uri: string) => {
  if (!uri.startsWith(AT_URI_PREFIX)) {
    return undefined;
  }

  const rest = uri.slice(AT_URI_PREFIX.length);
  const authorityEnd = rest.indexOf('/');
  if (authorityEnd < 0) {
    return undefined;
  }

  const authority = rest.slice(0, authorityEnd);
  const afterAuthority = rest.slice(authorityEnd + 1);
  const collectionEnd = afterAuthority.indexOf('/');
  if (collectionEnd < 0) {
    return undefined;
  }

  return {
    authority,
    collection: afterAuthority.slice(0, collectionEnd),
    rkey: afterAuthority.slice(collectionEnd + 1),
  };
};

/**
 * The string value of a field on a stored JSON record, or `undefined`. A stored
 * record is `Json`, so a field only reads as a string after a guard; this keeps
 * a malformed profile from inventing a displayName.
 */
const stringField = (value: Json) => (key: string) => {
  if (!Predicate.isObject(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === 'string' ? field : undefined;
};

/** What `indexedAt` falls back to when a record carries no `createdAt`. */
const AT_EPOCH = new Date(0).toISOString();

/** The DID an actor names: a DID is itself, a handle goes through the
 *  directory, and an unknown handle is `undefined`. */
const resolveActor = (handles: HandleResolverShape) => (actor: string) =>
  actor.startsWith('did:') ? Effect.succeed(actor) : handles.didOf(actor);

/** The 404 both actor reads answer with, when there is no actor to answer for. */
const notFound = () => Effect.fail(new HttpApiError.NotFound());

/**
 * The post records the store holds, across every repo, as the author feed and
 * the profile count both need them.
 *
 * ponytail: the store is scoped to the author's repo, but still read in one
 * bounded page and narrowed in memory. A store cursor into the author's own
 * posts is the upgrade when one author's timeline needs more than the ceiling.
 */
const FEED_SCAN_LIMIT = 1000;

const listPostRecords = (store: CanonicalStoreShape, repo: string) =>
  Effect.map(
    store.list({
      collection: POST_COLLECTION,
      repo,
      limit: FEED_SCAN_LIMIT,
    }),
    (page) => page.records,
  );

/** Which stored posts a profile tab keeps. `posts_no_replies` drops records
 *  that carry a `reply`, `posts_with_media` keeps only the ones with an
 *  `embed`, and everything else keeps all of them. */
const matchesAuthorFeedFilter =
  (filter: AuthorFeedFilter) => (record: CanonicalRecord) => {
    switch (filter) {
      case 'posts_no_replies':
        return !Predicate.hasProperty(record.value, 'reply');
      case 'posts_with_media':
        return Predicate.hasProperty(record.value, 'embed');
      default:
        return true;
    }
  };

export const hydratePost: (params: {
  readonly store: CanonicalStoreShape;
  readonly handles: HandleResolverShape;
  readonly uri: string;
}) => Effect.Effect<PostView | undefined> = ({ store, handles, uri }) =>
  Effect.gen(function* () {
    const record = yield* store.get(uri);
    if (record === undefined) {
      return undefined;
    }

    const key = parseAtUri(record.uri);
    if (key === undefined) {
      return undefined;
    }

    const did = key.authority;
    // The DID is the honest fallback when the directory knows no handle: the
    // screen still renders.
    const handle = (yield* handles.handleOf(did)) ?? did;

    // The profile is where displayName lives. Its absence just omits the field.
    const profile = yield* store.get(`at://${did}/${PROFILE_COLLECTION}/self`);
    const displayName =
      profile === undefined
        ? undefined
        : stringField(profile.value)('displayName');

    return {
      uri: record.uri,
      cid: record.cid,
      author: {
        did,
        handle,
        ...(displayName === undefined ? {} : { displayName }),
      },
      record: record.value,
      // ponytail: this store records no ingest timestamp, so the record's own
      // createdAt stands in for indexedAt; a real ingest timestamp is the
      // upgrade. A record without one gets the epoch rather than failing.
      indexedAt: stringField(record.value)('createdAt') ?? AT_EPOCH,
    };
  });

const notFoundThread = (uri: string) =>
  ({
    $type: 'app.bsky.feed.defs#notFoundPost',
    uri,
  }) satisfies (typeof GetPostThreadResponse.Type)['thread'];

const threadView = (post: PostView) =>
  ({
    $type: 'app.bsky.feed.defs#threadViewPost',
    post,
  }) satisfies (typeof GetPostThreadResponse.Type)['thread'];

export class FeedApiGroup extends HttpApiGroup.make('feed').add(
  HttpApiEndpoint.get('getPostThread', '/xrpc/app.bsky.feed.getPostThread', {
    query: {
      uri: Schema.String,
      depth: Schema.optionalKey(Schema.FiniteFromString),
      parentHeight: Schema.optionalKey(Schema.FiniteFromString),
    },
    success: GetPostThreadResponse,
  }),
  HttpApiEndpoint.get('getFeed', '/xrpc/app.bsky.feed.getFeed', {
    query: {
      feed: Schema.String,
      limit: Schema.optionalKey(Schema.FiniteFromString),
      cursor: Schema.optionalKey(Schema.String),
    },
    success: AuthorFeedResponse,
  }),
  HttpApiEndpoint.get('getAuthorFeed', '/xrpc/app.bsky.feed.getAuthorFeed', {
    query: {
      actor: Schema.String,
      filter: Schema.optionalKey(AuthorFeedFilter),
      limit: Schema.optionalKey(Schema.FiniteFromString),
      cursor: Schema.optionalKey(Schema.String),
      // Accepted so the XRPC surface matches the lexicon; the store has no
      // concept of a pinned post, so this is ignored.
      includePins: Schema.optionalKey(Schema.Boolean),
    },
    success: AuthorFeedResponse,
    error: HttpApiError.NotFound,
  }),
) {}

export class ActorApiGroup extends HttpApiGroup.make('actor').add(
  HttpApiEndpoint.get('getProfile', '/xrpc/app.bsky.actor.getProfile', {
    query: { actor: Schema.String },
    success: ProfileViewDetailed,
    error: HttpApiError.NotFound,
  }),
) {}

export class BskyApi extends HttpApi.make('bsky')
  .add(FeedApiGroup)
  .add(ActorApiGroup) {}

/**
 * The handler over an injected store and handle resolver, so the host supplies
 * both and an in-memory or durable store routes the same.
 */
export const bskyApiHandlers = Layer.mergeAll(
  HttpApiBuilder.group(BskyApi, 'feed', (handlers) =>
    handlers.handleAll({
      getPostThread: ({ query }) =>
        Effect.gen(function* () {
          const store = yield* CanonicalStore;
          const handles = yield* HandleResolver;

          // depth and parentHeight are ignored: see the module doc.
          const post = yield* hydratePost({ store, handles, uri: query.uri });

          return {
            thread:
              post === undefined ? notFoundThread(query.uri) : threadView(post),
          };
        }).pipe(Effect.withSpan('appview.bsky.getPostThread')),

      getFeed: ({ query }) =>
        Effect.gen(function* () {
          const store = yield* CanonicalStore;
          const handles = yield* HandleResolver;

          // The AppView runs no feed-generator algorithm: `feed` (the AT-URI
          // sky sends) is accepted, and the canonical store's posts are served
          // newest-first — the firehose stand-in for a closed network.
          const all = yield* store.list({
            collection: POST_COLLECTION,
            limit: FEED_SCAN_LIMIT,
          });

          const entries = all.records
            .flatMap((record) => {
              const rkey = parseAtUri(record.uri)?.rkey;
              return rkey === undefined ? [] : [{ rkey, record }];
            })
            // atproto rkeys are time-sortable TIDs, so descending is
            // newest-first.
            .sort((a, b) => (a.rkey < b.rkey ? 1 : a.rkey > b.rkey ? -1 : 0));

          const limit = query.limit ?? DEFAULT_AUTHOR_FEED_LIMIT;
          const start =
            query.cursor === undefined
              ? 0
              : entries.findIndex((entry) => entry.rkey === query.cursor) + 1;

          const page = entries.slice(start, start + limit);
          const hydrated = yield* Effect.forEach(page, (entry) =>
            hydratePost({ store, handles, uri: entry.record.uri }),
          );

          const lastRkey = page[page.length - 1]?.rkey;
          return {
            feed: hydrated.flatMap((post) =>
              post === undefined ? [] : [{ post }],
            ),
            ...(lastRkey === undefined || start + limit >= entries.length
              ? {}
              : { cursor: lastRkey }),
          };
        }).pipe(Effect.withSpan('appview.bsky.getFeed')),

      getAuthorFeed: ({ query }) =>
        Effect.gen(function* () {
          const store = yield* CanonicalStore;
          const handles = yield* HandleResolver;

          const did = yield* resolveActor(handles)(query.actor);
          if (did === undefined) {
            return yield* notFound();
          }

          const records = yield* listPostRecords(store, did);
          const entries = records
            .flatMap((record) => {
              const rkey = parseAtUri(record.uri)?.rkey;
              return rkey === undefined ? [] : [{ rkey, record }];
            })
            // atproto rkeys are time-sortable TIDs, so descending is
            // newest-first.
            .sort((a, b) => (a.rkey < b.rkey ? 1 : a.rkey > b.rkey ? -1 : 0));

          const matches = matchesAuthorFeedFilter(
            query.filter ?? 'posts_with_replies',
          );
          const mine = entries.filter((entry) => matches(entry.record));

          // resume by finding the cursor's rkey and continuing after it.
          // ponytail: O(n) per page in memory; a real cursor into the store is
          // the upgrade.
          const limit = query.limit ?? DEFAULT_AUTHOR_FEED_LIMIT;
          const start =
            query.cursor === undefined
              ? 0
              : mine.findIndex((entry) => entry.rkey === query.cursor) + 1;

          const page = mine.slice(start, start + limit);
          const hydrated = yield* Effect.forEach(page, (entry) =>
            hydratePost({ store, handles, uri: entry.record.uri }),
          );

          // The cursor is the last rkey consumed, and the last page has none,
          // so the client stops paging.
          const lastRkey = page[page.length - 1]?.rkey;
          return {
            feed: hydrated.flatMap((post) =>
              post === undefined ? [] : [{ post }],
            ),
            ...(lastRkey === undefined || start + limit >= mine.length
              ? {}
              : { cursor: lastRkey }),
          };
        }).pipe(Effect.withSpan('appview.bsky.getAuthorFeed')),
    }),
  ),
  HttpApiBuilder.group(BskyApi, 'actor', (handlers) =>
    handlers.handleAll({
      getProfile: ({ query }) =>
        Effect.gen(function* () {
          const store = yield* CanonicalStore;
          const handles = yield* HandleResolver;

          const did = yield* resolveActor(handles)(query.actor);
          if (did === undefined) {
            return yield* notFound();
          }

          const profile = yield* store.get(
            `at://${did}/${PROFILE_COLLECTION}/self`,
          );
          if (profile === undefined) {
            return yield* notFound();
          }

          // The DID is the honest fallback when the directory knows no handle.
          const handle = (yield* handles.handleOf(did)) ?? did;
          const displayName = stringField(profile.value)('displayName');
          const description = stringField(profile.value)('description');

          // Only this DID's posts are counted; followers and follows are not
          // in the store and are omitted rather than guessed.
          const records = yield* listPostRecords(store, did);
          const postsCount = records.length;

          return {
            did,
            handle,
            postsCount,
            ...(displayName === undefined ? {} : { displayName }),
            ...(description === undefined ? {} : { description }),
          };
        }).pipe(Effect.withSpan('appview.bsky.getProfile')),
    }),
  ),
);
