import {
  CODEC_DAG_CBOR,
  type CborValue,
  CidLink,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
  formatCid,
  parseCid,
} from '@eoa/core';
import { Effect, Match, Option, Result, Schema } from 'effect';
import {
  type HandlerContext,
  XrpcError,
  type XrpcServer,
} from '@eoa/xrpc-server';
import {
  type PdsConfig,
  authenticateAccess,
  resolveDid as didOf,
  forbidden,
  invalid,
  isPrivateCollection,
  notFound,
  readableDid,
  serverError,
} from './pds.js';
import {
  RepoStore,
  type RepoWriteMap,
  type WriteError,
  applyWrites,
  encodeTid,
  nextTid,
  readCar,
  recordsIn,
  writePut,
  writeRemove,
} from '@eoa/repo-store';
import type { WebhookEvent, WebhookNotifier } from './webhook.js';
import { type AccountStore } from './account-store.js';
import type { DpopReplay } from './dpop-replay.js';
import { type Firehose } from './firehose.js';
import { sha256 } from '@eoa/crypto';

/** The JSON a record travels as — the schema's own, so the two agree. */
type Json = Schema.Schema.Type<typeof Schema.Json>;

/**
 * A record as JSON: a CID link is `{$link}` and bytes are `{$bytes}`, which is
 * how atproto writes a reference — and the only form another implementation can
 * read. Everything else passes through as it stands.
 */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
export function toJson(value: CborValue): Json {
  if (value instanceof CidLink) {
    return { $link: formatCid(value.cid) };
  }
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map((one) => toJson(one));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => [key, toJson(one)]),
    );
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value ?? null;
}

/**
 * A record from its JSON: `{$link}` turns back into a link, so the bytes we
 * store — and the CID they hash to — are the ones atproto expects.
 */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
export function fromJson(value: Json): CborValue {
  if (Array.isArray(value)) {
    return value.map((one) => fromJson(one));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const at = (name: string) => entries.find(([key]) => key === name)?.[1];
    const link = at('$link');
    if (typeof link === 'string') {
      const parsed = parseCid(link);
      if (Result.isFailure(parsed)) {
        throw new BadRecord({ message: `not a CID: ${link}` });
      }
      return new CidLink({ cid: parsed.success });
    }
    const bytes = at('$bytes');
    if (typeof bytes === 'string') {
      return new Uint8Array(Buffer.from(bytes, 'base64'));
    }
    return Object.fromEntries(
      entries.map(([key, one]) => [key, fromJson(one)]),
    );
  }
  return value;
}

/** A record we cannot make bytes out of. */
class BadRecord extends Schema.TaggedError<BadRecord>()('BadRecord', {
  message: Schema.String,
}) {}

const CreateSchema = Schema.Struct({
  repo: Schema.String,
  collection: Schema.String,
  rkey: Schema.optional(Schema.String),
  record: Schema.Json,
  swapCommit: Schema.optional(Schema.String),
});

const PutSchema = Schema.Struct({
  repo: Schema.String,
  collection: Schema.String,
  rkey: Schema.String,
  record: Schema.Json,
  swapCommit: Schema.optional(Schema.String),
  swapRecord: Schema.optional(Schema.String),
});

const GetSchema = Schema.Struct({
  repo: Schema.String,
  collection: Schema.String,
  rkey: Schema.String,
});

const ListSchema = Schema.Struct({
  repo: Schema.String,
  collection: Schema.String,
  // Query parameters are strings; the handler is where one becomes a number.
  limit: Schema.optional(Schema.String),
  /**
   * The last key of the previous page, as `listRecords` handed it back.
   *
   * It was missing from this schema, which is why the handler could compute a cursor and never be
   * given one -- every page was page one (bean `84gp`).
   */
  cursor: Schema.optional(Schema.String),
});

const DeleteSchema = Schema.Struct({
  repo: Schema.String,
  collection: Schema.String,
  rkey: Schema.String,
  swapCommit: Schema.optional(Schema.String),
});

const DescribeSchema = Schema.Struct({ repo: Schema.String });

const WriteSchema = Schema.Union([
  Schema.Struct({
    $type: Schema.Literal('com.atproto.repo.applyWrites#create'),
    collection: Schema.String,
    rkey: Schema.optional(Schema.String),
    value: Schema.Json,
  }),
  Schema.Struct({
    $type: Schema.Literal('com.atproto.repo.applyWrites#update'),
    collection: Schema.String,
    rkey: Schema.String,
    value: Schema.Json,
  }),
  Schema.Struct({
    $type: Schema.Literal('com.atproto.repo.applyWrites#delete'),
    collection: Schema.String,
    rkey: Schema.String,
  }),
]);

const ApplySchema = Schema.Struct({
  repo: Schema.String,
  writes: Schema.Array(WriteSchema),
  swapCommit: Schema.optional(Schema.String),
});

/** What the surface needs to answer `repo.*`: the store, and who we are. */
export interface RepoSurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly repo: RepoStore['Service'];
  readonly replay: DpopReplay['Service'];
  readonly firehose: Firehose['Service'];
  /** Told about every write, so a site's build can be nudged once per window. */
  readonly webhooks?: WebhookNotifier | undefined;
  /**
   * Installed plugins, asked about a write: `transform` may change the record *before* it is
   * committed, `observed` is told after. The PDS keeps no policy of its own here — a deployment
   * decides which plugins are installed, what may run and in what order (bean `395u`).
   */
  readonly plugins?: PluginHooks | undefined;
}

/** What a write looks like to a plugin: whose record, where, and what is being written. */
export interface PluginWrite {
  readonly did: string;
  readonly collection: string;
  readonly rkey: string;
  readonly record: Schema.Json;
}

export interface PluginHooks {
  /**
   * The record as the plugins want it committed.
   *
   * A transform that fails, or takes too long, must not take the write down with it: the caller
   * is responsible for its own deadline and for answering with the record it was given, which is
   * what keeps a broken plugin from being an outage of the account's writes.
   */
  readonly transform?: (
    write: PluginWrite,
  ) => Effect.Effect<Schema.Json, unknown>;
  /** After the commit: what moved. Nothing a plugin says here changes the write. */
  readonly observed?: (write: PluginWrite) => Effect.Effect<void, unknown>;
}

const transformed = (
  deps: RepoSurfaceDeps,
  write: PluginWrite,
): Effect.Effect<Schema.Json> => {
  const transform = deps.plugins?.transform;
  return transform === undefined
    ? Effect.succeed(write.record)
    : transform(write).pipe(
        // A transform is an optimisation of the record, never a gate: a failure leaves the write
        // exactly as the client sent it.
        Effect.catchCause(() => Effect.succeed(write.record)),
      );
};

const noteObservers = (
  deps: RepoSurfaceDeps,
  write: PluginWrite,
): Effect.Effect<void> => {
  const observed = deps.plugins?.observed;
  return observed === undefined
    ? Effect.void
    : observed(write).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.timeout('2 seconds'),
        Effect.catchCause(() => Effect.void),
      );
};

const keyOf = (collection: string, rkey: string) => `${collection}/${rkey}`;

/**
 * The site a written record belongs to, when the record names one. A document may
 * carry `publication`; one that does not belongs to its account, which is what the
 * hook map falls back to.
 */
const noteWrite = (
  deps: RepoSurfaceDeps,
  event: WebhookEvent,
): Effect.Effect<void> =>
  deps.webhooks === undefined ? Effect.void : deps.webhooks.note(event);

const publicationOf = (record: Schema.Json): string | undefined => {
  const object =
    typeof record === 'object' && record !== null && !Array.isArray(record)
      ? // A JSON object is a record of JSON values; the array case is above.
        (record as Record<string, Schema.Json>)
      : undefined;
  const publication = object?.['publication'];
  return typeof publication === 'string' ? publication : undefined;
};

const uriOf = (did: string, collection: string, rkey: string) =>
  `at://${did}/${collection}/${rkey}`;

/** The CID of a record's bytes: what a client addresses it by. */
const cidOfRecord = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const digest = yield* sha256(bytes);
    return cidFromDigest({ codec: CODEC_DAG_CBOR, digest });
  });

/** One record as a plugin sees it: its key, its CID, and its value. */
export interface CollectionRecord {
  readonly rkey: string;
  readonly cid: string;
  readonly value: Json;
}

/**
 * One collection of one repo, whole — the read the plugin seam hands over (`cms-workspace`).
 *
 * It is `listRecords` without the paging: a caller that has to join several collections of the
 * same account (a document list and the drafts beside it) is better served by one answer than by
 * four walks of pages, and the account is the caller's own.
 *
 * `ponytail:` the whole collection, bodies and all, no projection and no cap; the editor loads
 * what it loaded before, in one response instead of many. A projection is the fix when an
 * account's documents get big enough to make this slow to open.
 */
export const collectionOf = (
  deps: RepoSurfaceDeps,
  did: string,
  collection: string,
) =>
  Effect.gen(function* () {
    const prefix = `${collection}/`;
    const records = yield* deps.repo
      .leaves(did, prefix, `${prefix}\uffff`)
      .pipe(Effect.mapError(() => notFound('RepoNotFound', did)));
    return yield* Effect.forEach(records, (one) =>
      Effect.gen(function* () {
        const cid = yield* cidOfRecord(one.value).pipe(
          Effect.mapError(() =>
            serverError('a record CID could not be computed'),
          ),
        );
        return {
          rkey: one.key.slice(prefix.length),
          cid: formatCid(cid),
          value: toJson(decodeCbor(one.value)),
        };
      }),
    );
  });

/** The distinct collections a repo holds, in order. */
const collectionsOf = (store: RepoStore['Service'], did: string) =>
  store
    .leaves(did, '', '\uffff')
    .pipe(
      Effect.map((records) =>
        [...new Set(records.map((one) => one.key.split('/')[0] ?? ''))]
          .filter((one) => one.length > 0)
          .sort(),
      ),
    );

/** The store's failures, in the words a client switches on. */
const asXrpcError = (did: string, error: WriteError) =>
  Match.value(error).pipe(
    Match.tag('NoSuchRepo', () => notFound('RepoNotFound', did)),
    Match.tag(
      'InvalidHead',
      () =>
        new XrpcError({
          error: 'InternalServerError',
          message: 'the head is not a commit',
          status: 500,
        }),
    ),
    Match.orElse(
      (other) =>
        new XrpcError({
          error: 'InternalServerError',
          message: other._tag,
          status: 500,
        }),
    ),
  );

/**
 * The client-facing repo API (the Effect-PDS map, `8d8x`).
 *
 * Every method reads and writes through `@eoa/repo-store`, and every
 * write goes through the same path the spec describes: `applyWrites` is one
 * commit, and `swapCommit` is the CAS the client asks for. A record's key is
 * the MST key — `collection/rkey` — so the surface and the tree agree on what a
 * record is called.
 */
/**
 * One commit, or the CAS refusal — never a half-applied write. Shared with the
 * moderation surface, which writes through the same path for the same reason a
 * client does: the stream has to hear about it.
 */
export const commitWrites = (
  deps: {
    readonly config: PdsConfig;
    readonly repo: RepoStore['Service'];
    readonly firehose: Firehose['Service'];
  },
  did: string,
  writes: ReadonlyArray<RepoWriteMap>,
  swapCommit: string | undefined,
  now: number,
) =>
  applyWrites({
    did,
    writes,
    swapCommit,
    signingKey: deps.config.signingKey,
    now,
    clockId: deps.config.clockId,
  }).pipe(
    // The transport runs a handler per request, so a handler has to be
    // self-contained: it carries the store rather than requiring it.
    Effect.provideService(RepoStore, deps.repo),
    Effect.mapError((error) => asXrpcError(did, error)),
    Effect.flatMap((outcome) =>
      Match.value(outcome).pipe(
        Match.tag('conflicted', (conflict) =>
          Effect.fail(
            new XrpcError({
              error: 'InvalidSwap',
              message: `the repo is at ${conflict.head}`,
              status: 400,
            }),
          ),
        ),
        Match.tag('committed', (done) => Effect.succeed(done)),
        Match.exhaustive,
      ),
    ),
    // The stream hears about it once the head has moved, so a reader resuming
    // from this event can fetch what it names. A commit whose blocks do not
    // parse is a corrupt row, not a failed write: the write stands, and the
    // stream is the thing that is wrong.
    // ponytail: an unparseable commit is dropped from the stream silently.
    Effect.tap((done) =>
      deps.firehose
        .emit({
          time: new Date(now).toISOString(),
          timeUs: now * 1000,
          did,
          commit: done.commit,
          rev: done.rev,
          since: done.since,
          ops: done.ops,
          blocks: done.blocks,
        })
        .pipe(Effect.ignore),
    ),
  );

export const registerRepoMethods = (
  server: XrpcServer,
  deps: RepoSurfaceDeps,
) => {
  /** The DID a request names — a repo is addressed by handle as well as by DID. */
  const resolveDid = (repo: string) => didOf(deps, repo);

  /**
   * A write's caller: the repo's owner, and nobody else. A read is open — an atproto repo is
   * readable by anyone — except for the collections the deployment keeps private (`requireSession`
   * below); a write is never open.
   */
  const requireOwner = (ctx: HandlerContext, repo: string) =>
    Effect.gen(function* () {
      const did = yield* resolveDid(repo);
      const caller = yield* authenticateAccess(deps, ctx);
      if (caller.account.did !== did) {
        return yield* Effect.fail(forbidden(`the repo ${did} is not yours`));
      }
      return did;
    });

  /**
   * The read gate: a collection the deployment keeps private is answered only to a session.
   *
   * Every read asks this before it resolves a repo, so a private collection says 401 rather than
   * 404 -- a caller without a session learns that the surface exists and is closed, not that the
   * record is missing.
   */
  const requireSession = (ctx: HandlerContext, collection: string) =>
    isPrivateCollection(deps.config, collection)
      ? authenticateAccess(deps, ctx).pipe(Effect.asVoid)
      : Effect.void;

  const recordBytes = (record: Json) =>
    Effect.try({
      try: () => encodeCbor(fromJson(record)),
      catch: () => invalid('the record is not encodable'),
    });

  server.method('com.atproto.repo.createRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(CreateSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createRecord'));
      }
      const input = decoded.value;
      const did = yield* requireOwner(ctx, input.repo);
      const now = Date.now();
      const rkey =
        input.rkey ?? (yield* nextTid({ now, clockId: deps.config.clockId }));
      const record = yield* transformed(deps, {
        did,
        collection: input.collection,
        rkey,
        record: input.record,
      });
      const bytes = yield* recordBytes(record);
      const outcome = yield* commitWrites(
        deps,
        did,
        [writePut({ key: keyOf(input.collection, rkey), bytes })],
        input.swapCommit,
        now,
      );
      const write = { did, collection: input.collection, rkey, record };
      yield* noteWrite(deps, { ...write, publication: publicationOf(record) });
      yield* noteObservers(deps, write);
      return {
        uri: uriOf(did, input.collection, rkey),
        cid: formatCid(yield* cidOfRecord(bytes)),
        commit: { cid: outcome.commit, rev: outcome.rev },
        validationStatus: 'valid',
      };
    }),
  );

  /**
   * `com.atproto.repo.putRecord`: the write a client makes when the key is *its* choice.
   *
   * The same commit `createRecord` makes — `writePut` replaces whatever is at the key — with the
   * `rkey` required rather than minted, because a caller that names a key means "this record,
   * here". It is also the method the CMS importer writes with, which is how its absence was
   * found: everything else that importer uses answered, and this one said `Method not found`.
   *
   * `swapRecord` is a **precondition on the record being replaced**: the caller names the cid it
   * read, and a write whose record has moved since is refused (`InvalidSwap`) rather than applied
   * to somebody else's version. That is what lets an editor — or an agent — change a document
   * without silently overwriting a change it never saw. `swapCommit` (the repo's revision) is
   * honoured too, because `commitWrites` does.
   */
  server.method('com.atproto.repo.putRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(PutSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for putRecord'));
      }
      const input = decoded.value;
      const did = yield* requireOwner(ctx, input.repo);
      // The precondition, checked against what is there now. A repo is written one request at a
      // time, so this read and the commit below cannot see two different versions.
      if (input.swapRecord !== undefined) {
        const current = yield* deps.repo
          .record(did, keyOf(input.collection, input.rkey))
          .pipe(
            Effect.mapError(() =>
              serverError(
                'the record that would be replaced could not be read',
              ),
            ),
          );
        const held = Option.isNone(current)
          ? undefined
          : formatCid(yield* cidOfRecord(current.value));
        if (held !== input.swapRecord) {
          return yield* Effect.fail(
            new XrpcError({
              error: 'InvalidSwap',
              status: 400,
              message: `swapRecord expected ${input.swapRecord}, but the record is ${held ?? 'absent'}`,
            }),
          );
        }
      }
      const now = Date.now();
      const record = yield* transformed(deps, {
        did,
        collection: input.collection,
        rkey: input.rkey,
        record: input.record,
      });
      const bytes = yield* recordBytes(record);
      const outcome = yield* commitWrites(
        deps,
        did,
        [writePut({ key: keyOf(input.collection, input.rkey), bytes })],
        input.swapCommit,
        now,
      );
      const write = {
        did,
        collection: input.collection,
        rkey: input.rkey,
        record,
      };
      yield* noteWrite(deps, {
        ...write,
        publication: publicationOf(record),
      });
      yield* noteObservers(deps, write);
      return {
        uri: uriOf(did, input.collection, input.rkey),
        cid: formatCid(yield* cidOfRecord(bytes)),
        commit: { cid: outcome.commit, rev: outcome.rev },
        validationStatus: 'valid',
      };
    }),
  );

  /**
   * `com.atproto.repo.importRepo` (the Effect-PDS map, `2b1f`).
   *
   * **A move, in the order it has to happen.** The source answers `sync.getRepo`
   * (and `sync.getBlob` for every blob `sync.listBlobs` names) *while it is still
   * serving*, because a deactivated account is not served — so
   * `deactivateAccount`, which is the spec's `suspend`, comes after the reading
   * and not before it. Then this: an account that holds no records takes the
   * CAR. `activateAccount` is not a step here — a `createAccount` destination is
   * already active; it is the way *back* for a suspended account, and the
   * password is the proof, since a suspended account holds no session to call it
   * with. Blobs travel beside the repo, and a blob's identity is its bytes, so
   * the CID is the same on both sides.
   *
   * The CAR is read, its records are written through the ordinary commit path,
   * and the repo's *content* is what arrives. Two things follow, and both are
   * deliberate.
   *
   * **The history does not.** The records keep their own bytes and CIDs — a
   * record's identity is its bytes — but the commits are the destination's and
   * the head is a fresh one. That is also what puts the move on the firehose: a
   * relay sees a `#commit` rather than silence, which is what "a repo moved here"
   * has to look like to anything that is watching.
   *
   * **The DID does not move across domains.** `wrds` made the DID
   * `did:web:{domain}:{random}`, independent of the handle, so a handle can be
   * released and retaken — but the *domain* is in it. An import into another
   * domain therefore cannot keep the DID, and a real cross-domain migration needs
   * a `did:plc`, which this PDS does not do. Within one domain — a restore, or a
   * move between PDSes serving it — the DID is unchanged, and so is every handle
   * that resolves through it.
   */
  server.method('com.atproto.repo.importRepo', {}, (ctx) =>
    Effect.gen(function* () {
      // The body *is* the CAR: the transport hands the bytes over, and this is
      // the only repo method that wants them raw.
      const body = ctx.body;
      if (body === undefined) {
        return yield* Effect.fail(
          invalid('importRepo takes a CAR as its body'),
        );
      }
      const caller = yield* authenticateAccess(deps, ctx);
      const did = caller.account.did;

      // An import arrives into an account that has not been *written to*: the
      // point is to install a repo, not to merge one over a live one. A fresh
      // account has a repo already — an empty one, with its own commit — so what
      // this asks is whether there are records, not whether there is a head.
      const held = yield* deps.repo
        .leaves(did, '', '\uffff')
        .pipe(Effect.mapError(() => serverError('the repo could not be read')));
      if (held.length > 0) {
        return yield* Effect.fail(
          invalid('importRepo needs an account that holds no records yet'),
        );
      }

      const car = yield* readCar(body).pipe(
        Effect.mapError((error) =>
          invalid(`that is not a CAR we can read: ${error.message}`),
        ),
      );
      const records = yield* recordsIn(car).pipe(
        Effect.mapError((error) =>
          invalid(`that CAR is not one we can hold: ${error.message}`),
        ),
      );
      if (records.length === 0) {
        return yield* Effect.fail(invalid('the CAR holds no records'));
      }

      // Through the ordinary write path, so the commit is signed by us and the
      // move is on the stream. A record's bytes are its identity: the CAR's own
      // bytes go to the store, which hashes them as they are, so the CIDs survive
      // the trip instead of moving with a re-encode (bean `mluh`).
      const outcome = yield* commitWrites(
        deps,
        did,
        records.map((one) => writePut({ key: one.key, bytes: one.value })),
        undefined,
        Date.now(),
      );
      return { commit: { cid: outcome.commit, rev: outcome.rev } };
    }),
  );

  server.method('com.atproto.repo.getRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(GetSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getRecord'));
      }
      const input = decoded.value;
      yield* requireSession(ctx, input.collection);
      const did = yield* readableDid(deps, input.repo);
      const found = yield* deps.repo
        .record(did, keyOf(input.collection, input.rkey))
        .pipe(Effect.mapError(() => notFound('RepoNotFound', did)));
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          notFound('RecordNotFound', `${input.collection}/${input.rkey}`),
        );
      }
      return {
        uri: uriOf(did, input.collection, input.rkey),
        cid: formatCid(yield* cidOfRecord(found.value)),
        value: toJson(decodeCbor(found.value)),
      };
    }),
  );

  server.method('com.atproto.repo.listRecords', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(ListSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listRecords'));
      }
      const input = decoded.value;
      yield* requireSession(ctx, input.collection);
      const did = yield* readableDid(deps, input.repo);
      const prefix = `${input.collection}/`;
      // The cursor is the **last key of the previous page**, and `leaves` scans exclusively from
      // where it is pointed -- so a client that pages walks the collection instead of looping over
      // its first page (bean `84gp`).
      const records = yield* deps.repo
        .leaves(did, input.cursor ?? prefix, `${prefix}\uffff`)
        .pipe(Effect.mapError(() => notFound('RepoNotFound', did)));
      const asked = Number(input.limit ?? '50');
      const limit = Math.max(
        1,
        Math.min(Number.isFinite(asked) ? asked : 50, 100),
      );
      const page = records.slice(0, limit);
      const last = page.at(-1);
      return {
        records: yield* Effect.forEach(page, (one) =>
          Effect.gen(function* () {
            return {
              uri: uriOf(did, input.collection, one.key.slice(prefix.length)),
              cid: formatCid(yield* cidOfRecord(one.value)),
              value: toJson(decodeCbor(one.value)),
            };
          }),
        ),
        ...(records.length > page.length && last !== undefined
          ? { cursor: last.key }
          : {}),
      };
    }),
  );

  server.method('com.atproto.repo.deleteRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(DeleteSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for deleteRecord'));
      }
      const input = decoded.value;
      const did = yield* requireOwner(ctx, input.repo);
      const outcome = yield* commitWrites(
        deps,
        did,
        [writeRemove({ key: keyOf(input.collection, input.rkey) })],
        input.swapCommit,
        Date.now(),
      );
      yield* noteWrite(deps, {
        did,
        collection: input.collection,
        rkey: input.rkey,
      });
      return { commit: { cid: outcome.commit, rev: outcome.rev } };
    }),
  );

  server.method('com.atproto.repo.applyWrites', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(ApplySchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for applyWrites'));
      }
      const input = decoded.value;
      const did = yield* requireOwner(ctx, input.repo);
      const now = Date.now();
      // Each create without a key gets a TID of its own: one TID for the whole call would give every
      // such write the same key, and all but the last would be overwritten in the same commit.
      type Planned = {
        readonly collection: string;
        readonly rkey: string;
        readonly bytes: Uint8Array | undefined;
        readonly update: boolean;
      };
      const planned: Planned[] = [];
      for (const [index, one] of input.writes.entries()) {
        if (one.$type === 'com.atproto.repo.applyWrites#delete') {
          planned.push({
            collection: one.collection,
            rkey: one.rkey,
            bytes: undefined,
            update: false,
          });
          continue;
        }
        planned.push({
          collection: one.collection,
          rkey:
            one.rkey ??
            encodeTid({
              micros: now * 1000 + index,
              clockId: deps.config.clockId,
            }),
          bytes: yield* recordBytes(one.value),
          update: one.$type === 'com.atproto.repo.applyWrites#update',
        });
      }
      const outcome = yield* commitWrites(
        deps,
        did,
        planned.map(({ collection, rkey, bytes }) =>
          bytes === undefined
            ? writeRemove({ key: keyOf(collection, rkey) })
            : writePut({ key: keyOf(collection, rkey), bytes }),
        ),
        input.swapCommit,
        now,
      );
      for (const { collection, rkey } of planned) {
        yield* noteWrite(deps, { did, collection, rkey });
      }
      const results: Json[] = [];
      for (const { collection, rkey, bytes, update } of planned) {
        results.push(
          bytes === undefined
            ? { $type: 'com.atproto.repo.applyWrites#deleteResult' }
            : {
                $type: update
                  ? 'com.atproto.repo.applyWrites#updateResult'
                  : 'com.atproto.repo.applyWrites#createResult',
                uri: uriOf(did, collection, rkey),
                cid: formatCid(yield* cidOfRecord(bytes)),
                validationStatus: 'valid',
              },
        );
      }
      return { commit: { cid: outcome.commit, rev: outcome.rev }, results };
    }),
  );

  server.method('com.atproto.repo.describeRepo', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(DescribeSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for describeRepo'));
      }
      const input = decoded.value;
      const did = yield* readableDid(deps, input.repo);
      const head = yield* deps.repo
        .head(did)
        .pipe(Effect.mapError(() => notFound('RepoNotFound', did)));
      if (Option.isNone(head)) {
        return yield* Effect.fail(notFound('RepoNotFound', did));
      }
      // The handle is the account's own, so it is right by construction — the
      // account store is what resolves one, and what says it still holds it.
      const account = yield* deps.accounts
        .account(did)
        .pipe(Effect.mapError(() => notFound('RepoNotFound', did)));
      if (Option.isNone(account)) {
        return yield* Effect.fail(notFound('RepoNotFound', did));
      }
      return {
        did,
        handle: account.value.handle,
        handleIsCorrect: true,
        collections: yield* collectionsOf(deps.repo, did),
      };
    }),
  );
};
