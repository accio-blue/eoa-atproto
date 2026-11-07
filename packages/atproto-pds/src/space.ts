import {
  ATURI,
  CODEC_DAG_CBOR,
  type CborValue,
  DID,
  NSID,
  TID,
  cidFromDigest,
  decodeCbor,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import {
  BadRecordSwapError,
  CidString,
  MANAGED_POLICY_TYPE,
  MEMBER_POLICY_TYPE,
  MEMBER_RECORD_COLLECTION,
  MemberAccess,
  POLICY_RECORD_COLLECTION,
  type Policy,
  RecordKey,
  SPACE_COMMIT_VER,
  SPACE_CREDENTIAL_TTL_SECONDS,
  SPACE_META_STAR,
  SPACE_META_VER,
  SPACE_REPO_STAR,
  type Space,
  type SpaceClearOp,
  type SpaceMetaArchive,
  type SpaceMetaValue,
  type SpaceRecordOp,
  type SpaceRepoRef,
  SpaceWriteLog,
  StaleEpochError,
  WriteLock,
  appApproved,
  appOfProofUnverified,
  blockCidOf,
  checkAccess,
  credentialFor,
  decideSessionRead,
  decideWrite,
  decodePolicy,
  digestOf,
  encodeRepoStar,
  encodeSpaceMetaStar,
  foldState,
  jktOfKey,
  ltHashDigestOf,
  memberRecordsOf,
  parseRepoStar,
  parseSpaceMetaStar,
  policyRecordOf,
  policyStateSurvives,
  spaceFromUri,
  verifyAppProof,
  verifyRepoStar,
  verifySpaceCredential,
} from '@eoa/space-host';
import {
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
  Stream,
} from 'effect';
import { type Firehose, type SpaceCommitEvent } from './firehose.js';
import {
  type HandlerContext,
  type XrpcError,
  type XrpcServer,
} from '@eoa/xrpc-server';
import {
  type PdsConfig,
  authenticateAccess,
  bearer,
  conflict,
  forbidden,
  invalid,
  notFound,
  serverError,
  unauthorized,
} from './pds.js';
import { fromJson, toJson } from './repo.js';
import { grantsAndRevocations, spaceGrantLayers } from './space-grants.js';
import { type AccountStore } from './account-store.js';
import { type BlobStore } from './blob-store.js';
import { type DpopReplay } from './dpop-replay.js';
import { type IdentityResolver } from '@eoa/identity';
import { type PublicKey } from '@eoa/crypto';
import { type SpaceHooks } from './space-hooks.js';
import { type SpaceStore } from './space-store.js';
import { askManagingApp } from './managing-app.js';
import { blobCidsIn } from './blob.js';
import { nextTid } from '@eoa/repo-store';
import { sha256 } from '@eoa/crypto';

/**
 * The spaces surface a **repo host** owes its accounts (spaces alpha,
 * 2026-10-29). It accepts a space's host-side state and an account's repo in a
 * space, serves them back, and - since the write path landed - is where records
 * in a space actually live.
 *
 * A space repo is not an MST repo: it is the STAR/op-log model, one repo PER
 * (space, account), and the append-only log (`SpaceWriteLog`) is its truth.
 * Current state is a fold over that log; `getRepo` re-encodes the STAR archive
 * from it, so the `data` digest a destination serves is the one the source's
 * archive had (the bytes are carried, not re-read from `RepoStore`).
 *
 * Every write goes through the log's head CAS and the host's fencing epoch, so
 * two writers on one base cannot both land and a superseded host fails. The
 * policy decides *who* may write; the log decides *whether this attempt* may.
 */

/** A space URI, parsed. `undefined` when the string is not a space address. */
const spaceOf = (value: string): Space | undefined => {
  const decoded = Schema.decodeUnknownOption(ATURI)(value);
  return Option.isNone(decoded) ? undefined : spaceFromUri(decoded.value);
};

const SPACE_PARAM = Schema.Struct({ space: Schema.String });

/** What the authority asks for: the space, the app it approves, and that app's DPoP thumbprint. */
const CREDENTIAL_INPUT = Schema.Struct({
  space: Schema.String,
  app: Schema.String,
  jkt: Schema.String,
});

/**
 * `createSpace`'s input. `policy` is `Unknown` on purpose: the union is decoded by `decodePolicy`, so
 * a `$type` this host does not implement is `UnsupportedPolicy` rather than a schema message.
 */
const CREATE_SPACE_INPUT = Schema.Struct({
  spaceType: Schema.String,
  skey: Schema.optional(Schema.String),
  policy: Schema.Unknown,
});

const SPACE_REPO_PARAM = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
});

/** `updateSpace`: the policy replaces the one the space was made with. */
const UPDATE_SPACE_INPUT = Schema.Struct({
  space: Schema.String,
  policy: Schema.Unknown,
});

const SPACE_RECORD_PARAM = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
  collection: Schema.String,
  rkey: Schema.String,
});

/** `putMember`: the access pair the memberspace policy reads, and the DID it is for. */
const PUT_MEMBER_INPUT = Schema.Struct({
  space: Schema.String,
  did: Schema.String,
  read: Schema.Boolean,
  write: Schema.Boolean,
});

const SPACE_MEMBER_PARAM = Schema.Struct({
  space: Schema.String,
  did: Schema.String,
});

const CREATE_RECORD_INPUT = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
  collection: Schema.String,
  rkey: Schema.optional(Schema.String),
  validate: Schema.optional(Schema.Boolean),
  record: Schema.Json,
});

const DELETE_RECORD_INPUT = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
  collection: Schema.String,
  rkey: Schema.String,
});

const WRITE_ITEM = Schema.Union([
  Schema.Struct({
    $type: Schema.Literal('com.atproto.space.applyWrites#create'),
    collection: Schema.String,
    rkey: Schema.optional(Schema.String),
    value: Schema.Json,
  }),
  Schema.Struct({
    $type: Schema.Literal('com.atproto.space.applyWrites#update'),
    collection: Schema.String,
    rkey: Schema.String,
    value: Schema.Json,
  }),
  Schema.Struct({
    $type: Schema.Literal('com.atproto.space.applyWrites#delete'),
    collection: Schema.String,
    rkey: Schema.String,
  }),
]);

const APPLY_WRITES_INPUT = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
  validate: Schema.optional(Schema.Boolean),
  writes: Schema.Array(WRITE_ITEM),
});

const LIST_SPACES_PARAM = Schema.Struct({
  spaceType: Schema.optional(Schema.String),
  did: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
});

const LIST_RECORDS_PARAM = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
  collection: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  reverse: Schema.optional(Schema.String),
  excludeValues: Schema.optional(Schema.String),
});

const LIST_BLOBS_PARAM = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
  since: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
});

const GET_BLOB_PARAM = Schema.Struct({
  space: Schema.String,
  repo: Schema.String,
  cid: Schema.String,
});

/**
 * What a service asks on a member's behalf: may this caller read or write one
 * collection in the space? The caller is the token, never a `did` parameter —
 * otherwise anyone could ask about anyone.
 */
const CHECK_ACCESS_PARAM = Schema.Struct({
  space: Schema.String,
  action: Schema.Literals(['view', 'write']),
  collection: Schema.optional(Schema.String),
});

/**
 * A decoded policy, as the archive carries it.
 *
 * The value is a plain map of strings, booleans and arrays of strings — which is what a CBOR map is —
 * but the schema's union has no index signature, so TypeScript cannot see the one through the other.
 * The assertion is the seam between a decoded struct and the wire type, and it is here rather than at
 * every call that builds an archive.
 */
const policyValue = (policy: Policy): SpaceMetaValue =>
  policy as unknown as SpaceMetaValue;

/** A query parameter's integer, clamped to what the lexicon allows. */
const limitOf = (asked: string | undefined, fallback: number, max: number) => {
  const value = Number(asked ?? fallback);
  return Math.min(Math.max(Number.isFinite(value) ? value : fallback, 1), max);
};

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, at) => byte === right[at]);

/** The index `digestOf` folds: every record path to the CID of its bytes. */
const indexOf = (records: ReadonlyArray<{ key: string; value: Uint8Array }>) =>
  Effect.forEach(records, (record) =>
    blockCidOf(record.value).pipe(
      Effect.map((cid) => [record.key, cid] as const),
    ),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

/** What a space repo's commit `data` is: the LtHash fold of its records. */
const dataOf = (records: ReadonlyArray<{ key: string; value: Uint8Array }>) =>
  indexOf(records).pipe(Effect.flatMap(digestOf));

const recordOf = (value: Uint8Array) =>
  Effect.try({
    try: () => decodeCbor(value),
    catch: () => serverError('a record could not be read'),
  });

/**
 * Every record, re-encoded and checked against its own bytes.
 *
 * Section 5d asks an importer to reject a record whose DRISL encoding does not
 * match its CID. The archive carries no per-record CID, so the check is the
 * encoding itself: a deterministic CBOR round trip must reproduce the bytes,
 * and the CID is a hash over those bytes. A record that re-encodes differently
 * is one whose bytes are not the canonical form of its value.
 */
const canonicalRecords = (
  records: ReadonlyArray<{ path: string; block: Uint8Array }>,
) =>
  Effect.forEach(records, (record) =>
    Effect.try({
      try: () => {
        const reencoded = encodeCbor(decodeCbor(record.block));
        if (!sameBytes(reencoded, record.block)) {
          throw new Error('not canonical');
        }
        return { key: record.path, value: record.block };
      },
      catch: () =>
        invalid(`the record at ${record.path} is not canonical DRISL`),
    }),
  );

/** The one policy-state key a baseline policy defines. */
const MEMBER_STATE_PREFIX = 'com.atproto.memberspace.member/';

const MemberState = Schema.Struct({
  $type: Schema.optional(Schema.Literal('com.atproto.memberspace.member')),
  read: Schema.Boolean,
  write: Schema.Boolean,
});

/**
 * A policy-state key the policy does not define is a refusal, never a drop: an
 * importer that silently discarded it would accept a space whose access rules
 * lost a member between hosts (section 5b).
 */
const validatePolicyState = (archive: SpaceMetaArchive, policy: Policy) =>
  Effect.gen(function* () {
    if (policy.$type !== MEMBER_POLICY_TYPE) {
      const extra = archive.policyState[0];
      if (extra !== undefined) {
        return yield* Effect.fail(
          invalid(
            `the ${policy.$type} policy keeps no state, but the archive carries ${extra.key}`,
          ),
        );
      }
      return;
    }
    for (const entry of archive.policyState) {
      if (!entry.key.startsWith(MEMBER_STATE_PREFIX)) {
        return yield* Effect.fail(
          invalid(
            `a ${policy.$type} policy does not define the state key ${entry.key}`,
          ),
        );
      }
      const did = entry.key.slice(MEMBER_STATE_PREFIX.length);
      if (Option.isNone(Schema.decodeUnknownOption(DID)(did))) {
        return yield* Effect.fail(
          invalid(`the member state key ${entry.key} does not name a DID`),
        );
      }
      if (Option.isNone(Schema.decodeUnknownOption(MemberState)(entry.value))) {
        return yield* Effect.fail(
          invalid(`the member state at ${entry.key} is not an access entry`),
        );
      }
    }
  });

/**
 * A space meta archive, checked: framing and section order first (the STAR
 * reader's job), then ownership, the policy, and the state the policy claims.
 * Exported so the refusals can be tested without an HTTP surface.
 */
export const validateSpaceMeta = (params: {
  readonly bytes: Uint8Array;
  readonly callerDid: string;
}) =>
  Effect.gen(function* () {
    const archive = yield* parseSpaceMetaStar(params.bytes).pipe(
      Effect.mapError((error) =>
        invalid(`that is not a space meta archive: ${error.reason}`),
      ),
    );
    const space = spaceOf(archive.meta.space);
    if (space === undefined) {
      return yield* Effect.fail(
        invalid('the archive metadata does not name a space'),
      );
    }
    if (space.authority !== params.callerDid) {
      return yield* Effect.fail(
        notFound(
          'NotSpaceOwner',
          `the space ${archive.meta.space} is not anchored on ${params.callerDid}`,
        ),
      );
    }
    const policy = yield* decodePolicy(archive.policy).pipe(
      Effect.mapError(() =>
        notFound(
          'UnsupportedPolicy',
          `the policy at ${archive.meta.space} is not one this host implements`,
        ),
      ),
    );
    yield* validatePolicyState(archive, policy);
    return { archive, policy, space };
  });

/**
 * The log a host keeps, and the fence every write goes through. A deployment
 * that names none gets an in-memory pair (see `createPdsServer`); the durable
 * pair is `spaceWriteLogKvLayer` with a lease-backed `WriteLock`.
 */
export interface SpaceWrites {
  readonly log: SpaceWriteLog['Service'];
  readonly lock: WriteLock['Service'];
}

/** What the spaces surface needs: the stores, the accounts, and who we are. */
export interface SpaceSurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly blobs: BlobStore['Service'];
  readonly spaces: SpaceStore['Service'];
  readonly replay: DpopReplay['Service'];
  readonly writes: SpaceWrites;
  /**
   * How an app's key is found when it asks for a credential without a session (`frxd`): a `did:web`
   * document over the network in a deployment, a map in a test. Absent means an app cannot ask,
   * and only the authority's own session mints.
   */
  readonly appKeys?:
    | ((did: string) => Effect.Effect<PublicKey | undefined>)
    | undefined;
  /**
   * Who to tell when a space stops existing (`frxd`): the apps that were reading it drop their
   * copies now instead of at their next pull. Absent means this host tells nobody.
   */
  readonly spaceHooks?: SpaceHooks | undefined;
  /**
   * Where a space's writes are told (`subscribeRepos` for a space). Absent means this host serves no
   * space stream — a pull-only deployment, and every test that does not ask for one.
   */
  readonly firehose?: Firehose['Service'] | undefined;
  /**
   * How the authority finds its managing app (`70cr`): a `did#fragment` resolved to the endpoint the
   * app advertises. Absent means a `managedspace` cannot be asked, and every write into it is
   * refused with that sentence rather than with a guess.
   */
  readonly identity?: IdentityResolver | undefined;
}

/**
 * The log's two expected refusals, said as XRPC errors.
 *
 * `BadRecordSwapError` is **retry**: the head moved between reading it and
 * committing, so re-read the repo and write again on the new base. The write
 * did not happen. `StaleEpochError` is **stop**: this host has been superseded
 * as the writer, so the same epoch can never succeed; the host has to re-acquire
 * the lease (or stay out of the way).
 */
const logFailure = (error: BadRecordSwapError | StaleEpochError) =>
  error instanceof StaleEpochError
    ? invalid(
        `this host is no longer the writer for ${error.space} (epoch ${error.presented}, current ${error.current}); stop, do not retry here`,
      )
    : invalid(
        `the repo moved under this write (expected ${error.expected ?? 'empty'}, found ${error.actual ?? 'empty'}); re-read and retry`,
      );

export const registerSpaceMethods = (
  server: XrpcServer,
  deps: SpaceSurfaceDeps,
) => {
  /**
   * The grant evaluator over this host's space log: grants live in the authority's repo in the
   * space, which is why one read answers a whole check (`space-grants.ts`).
   */
  const grantLayers = spaceGrantLayers.pipe(
    Layer.provide(Layer.succeed(SpaceWriteLog, deps.writes.log)),
  );

  /** The DID a repo request names, refused when it is not the caller's own. */
  const requireOwnRepo = (callerDid: string, asked: string) =>
    asked === callerDid
      ? Effect.void
      : Effect.fail(forbidden(`the repo ${asked} is not yours`));

  /**
   * The space, when the caller is its authority — the only account that may change its member list.
   *
   * Refused as `NotSpaceOwner`, the name `deleteSpace` already uses for the same question, so a
   * client reads one error for "this space is not yours to administer".
   */
  const requireAuthority = (callerDid: string, spaceUri: string) =>
    Effect.gen(function* () {
      const space = spaceOf(spaceUri);
      if (space === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${spaceUri} is not a space address`),
        );
      }
      if (space.authority !== callerDid) {
        return yield* Effect.fail(
          notFound('NotSpaceOwner', `${spaceUri} is not yours to administer`),
        );
      }
      return space;
    });

  const didOf = (value: string) => Schema.decodeSync(DID)(value);

  /** A member's state key: the one shape `decideWrite` looks up. */
  const memberKey = (did: string) => `${MEMBER_STATE_PREFIX}${did}`;

  /** A DID out of a request, refused rather than decoded blindly. */
  const memberDidOf = (value: string) =>
    Effect.gen(function* () {
      const did = Option.getOrUndefined(Schema.decodeUnknownOption(DID)(value));
      if (did === undefined) {
        return yield* Effect.fail(invalid(`the member ${value} is not a DID`));
      }
      return did;
    });

  /**
   * The **policy's** answer about a read: the authority, a member's `read`, `publicRead`.
   *
   * The coarse axis. `allow` is a yes; everything else — a personal space's silence, a member entry
   * that says `read: false`, a managed space whose read the managing app would have to answer — falls
   * through to the grant gate, because a policy that does not say yes is not a policy that says no to
   * a grant (`Deny` means "not through me", `Ask` means "not my question").
   */
  const policyReadOf = (params: {
    readonly space: string;
    readonly authority: string;
    readonly did: string;
  }): Effect.Effect<
    | { readonly kind: 'allow' }
    | { readonly kind: 'else'; readonly reason: string },
    XrpcError
  > =>
    Effect.gen(function* () {
      const held = yield* deps.spaces
        .meta(params.space)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${params.space} on this host`),
        );
      }
      const archive = yield* parseSpaceMetaStar(held.value).pipe(
        Effect.mapError(() => serverError('the stored space does not parse')),
      );
      const policy = yield* decodePolicy(archive.policy).pipe(
        Effect.mapError(() =>
          serverError('the stored space policy does not parse'),
        ),
      );
      const entry = archive.policyState.find(
        (one) => one.key === memberKey(params.did),
      );
      const member =
        entry === undefined
          ? undefined
          : Option.getOrUndefined(
              Schema.decodeUnknownOption(MemberAccess)(entry.value),
            );
      return Match.value(
        decideSessionRead({
          policy,
          did: didOf(params.did),
          authority: didOf(params.authority),
          member,
        }),
      ).pipe(
        Match.tag('Allow', () => ({ kind: 'allow' as const })),
        Match.tag('Deny', (denied) => ({
          kind: 'else' as const,
          reason: String(denied.reason),
        })),
        Match.tag('Ask', () => ({
          kind: 'else' as const,
          reason: 'the managing app decides reads',
        })),
        Match.exhaustive,
      );
    });

  /**
   * May this reader see this repo in this space? Its own repo always; another's only through a
   * grant, which is the second axis of access (`70cr`) and deliberately not the write gate.
   *
   * An app holding a space credential is already scoped by the credential: what it may see is what
   * the authority approved when it minted one, so it does not go through grants.
   */
  const mayRead = (params: {
    readonly reader:
      | { readonly kind: 'session'; readonly did: string }
      | { readonly kind: 'app'; readonly app: string };
    readonly space: string;
    readonly repo: string;
    readonly collection?: string | undefined;
    readonly rkey?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const reader = params.reader;
      if (reader.kind === 'app') return;
      if (reader.did === params.repo) return;
      const space = spaceOf(params.space);
      if (space === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${params.space} is not a space address`),
        );
      }
      // The policy first: the authority, a member's `read`, `publicRead`. A space's own answer is
      // cheaper and broader than a grant, and it is what a memberspace is for.
      const policy = yield* policyReadOf({
        space: params.space,
        authority: space.authority,
        did: reader.did,
      });
      if (policy.kind === 'allow') return;
      const record =
        params.collection === undefined || params.rkey === undefined
          ? undefined
          : `at://${params.repo}/${params.collection}/${params.rkey}`;
      const decision = yield* checkAccess({
        space: Schema.decodeSync(ATURI)(params.space),
        did: didOf(reader.did),
        action: 'view',
        ...(params.collection === undefined
          ? {}
          : { collection: Schema.decodeSync(NSID)(params.collection) }),
        ...(record === undefined
          ? {}
          : { record: Schema.decodeSync(ATURI)(record) }),
      }).pipe(Effect.provide(grantLayers));
      yield* Match.value(decision).pipe(
        Match.tag('Allow', () => Effect.void),
        Match.tag('Deny', (denied) =>
          Effect.fail(
            forbidden(
              `no grant covers ${params.collection ?? params.repo} in ${params.space} for ${reader.did}: ${denied.reason} (policy: ${policy.reason})`,
            ),
          ),
        ),
        Match.exhaustive,
      );
    });

  /**
   * The same gate as `mayRead`, as a yes/no.
   *
   * A blob asks it once per record that could carry it, and needs no sentence per refusal — the
   * caller answers with one. Everything else about the answer is `mayRead`'s: own repo, an app
   * credential, or a grant, fail-closed.
   */
  const mayReadQuietly = (params: Parameters<typeof mayRead>[0]) =>
    mayRead(params).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );

  /** The log ref a read names, refusing anything that is not a space address. */
  const refOf = (spaceUri: string, did: string) =>
    Effect.gen(function* () {
      if (spaceOf(spaceUri) === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${spaceUri} is not a space address`),
        );
      }
      return {
        space: Schema.decodeSync(ATURI)(spaceUri),
        did: didOf(did),
      } satisfies SpaceRepoRef;
    });

  const collectionOf = (value: string) =>
    Option.getOrUndefined(Schema.decodeUnknownOption(NSID)(value));

  const recordKeyOf = (value: string) =>
    Option.getOrUndefined(Schema.decodeUnknownOption(RecordKey)(value));

  const revOf = () =>
    nextTid({ now: Date.now(), clockId: deps.config.clockId }).pipe(
      Effect.mapError(() => serverError('a revision was not made')),
    );

  const cidOf = (bytes: Uint8Array) =>
    blockCidOf(bytes).pipe(
      Effect.map((cid) => Schema.decodeSync(CidString)(formatCid(cid))),
      Effect.mapError(() => serverError('the record could not be hashed')),
    );

  /** A delete has no record bytes, so its op CID is a digest of what it is. */
  const deleteCidOf = (path: string, rev: string) =>
    cidOf(new TextEncoder().encode(`delete:${path}:${rev}`));

  const bytesOfRecord = (record: Schema.Json) =>
    Effect.try({
      try: () => encodeCbor(fromJson(record)),
      catch: () => invalid('the record is not encodable'),
    });

  /**
   * Who is reading a space (`frxd`): a session, or an **approved app** presenting a credential
   * together with a proof signed by the key that credential is bound to.
   *
   * The token alone is not a password: `cnf.jkt` names the app's key, the proof has to verify
   * against that same key, and it names the space it is for — so a leaked token is useless without
   * the key and a captured proof opens one space for a minute.
   */
  const readerOf = (ctx: HandlerContext, space: string) =>
    Effect.gen(function* () {
      const session = yield* authenticateAccess(deps, ctx).pipe(Effect.option);
      if (Option.isSome(session)) {
        return { kind: 'session' as const, did: session.value.account.did };
      }
      const token = bearer(ctx);
      const proof = ctx.headers['dpop'];
      if (
        token === undefined ||
        proof === undefined ||
        deps.appKeys === undefined
      ) {
        return yield* Effect.fail(
          unauthorized(
            'a session, or a space credential with a proof for its key',
          ),
        );
      }
      // Only to know whose key to fetch: the credential below has to name the same app, and the
      // proof only verifies against the key that DID publishes.
      const app = appOfProofUnverified(proof);
      if (app === undefined) {
        return yield* Effect.fail(unauthorized('the proof names no app'));
      }
      const key = yield* deps
        .appKeys(app)
        .pipe(
          Effect.mapError(() => serverError('the app key could not be read')),
        );
      if (key === undefined) {
        return yield* Effect.fail(
          unauthorized(`no key is published for ${app}`),
        );
      }
      const jkt = yield* jktOfKey(key);
      if (jkt === undefined) {
        return yield* Effect.fail(
          unauthorized(`the key of ${app} has no thumbprint`),
        );
      }
      const now = Date.now();
      const credential = yield* verifySpaceCredential({
        token,
        key: deps.config.signingKey.publicKey,
        audience: deps.config.did,
        space,
        now,
        jkt,
        app,
      });
      if (!credential.ok) {
        return yield* Effect.fail(
          unauthorized(
            `the credential does not open this space: ${credential.reason}`,
          ),
        );
      }
      const verified = yield* verifyAppProof({
        proof,
        key,
        audience: deps.config.did,
        space,
        now,
      });
      if (!verified.ok) {
        return yield* Effect.fail(unauthorized(verified.reason));
      }
      return { kind: 'app' as const, app };
    });

  /** The entries of a repo, or `RepoNotFound` when the log never held it. */
  const entriesOf = (ref: SpaceRepoRef) => deps.writes.log.entries(ref);

  const requireRepo = (ref: SpaceRepoRef) =>
    Effect.gen(function* () {
      const entries = yield* entriesOf(ref);
      if (entries.length === 0) {
        return yield* Effect.fail(
          notFound('RepoNotFound', `no repo for ${ref.did} in ${ref.space}`),
        );
      }
      return entries;
    });

  const stateOf = (ref: SpaceRepoRef) => deps.writes.log.state(ref);

  /** The values a STAR archive carries, refusing a row that lost its bytes. */
  const recordsOf = (ref: SpaceRepoRef) =>
    Effect.gen(function* () {
      const state = yield* stateOf(ref);
      return yield* Effect.forEach([...state], ([key, head]) =>
        head.value === undefined
          ? Effect.fail(serverError(`the record at ${key} has no bytes`))
          : Effect.succeed({ key, value: head.value }),
      );
    });

  /** The bytes of the caller's repo in a space, as a STAR archive. */
  const repoStarOf = (params: {
    readonly ref: SpaceRepoRef;
    readonly rev: string;
  }) =>
    Effect.gen(function* () {
      const records = yield* recordsOf(params.ref);
      const data = yield* dataOf(records);
      return yield* encodeRepoStar({
        meta: {
          $type: SPACE_REPO_STAR,
          ver: SPACE_COMMIT_VER,
          repo: params.ref.did,
          space: params.ref.space,
          rev: Schema.decodeSync(TID)(params.rev),
          data,
        },
        records: records.map((record) => ({
          path: record.key,
          block: record.value,
        })),
      }).pipe(
        Effect.mapError((error) =>
          serverError(`the space repo could not be encoded: ${error.reason}`),
        ),
      );
    });

  /**
   * The policy's answer about this account, and the repo ref. The authority is
   * allowed by every policy; a member only when the policy and its entry say so.
   * A `managedspace` defers to its managing app, which this host cannot ask yet:
   * that is refused with a reason rather than allowed or silently denied.
   */
  const authorizeWrite = (spaceUri: string, callerDid: string) =>
    Effect.gen(function* () {
      const space = spaceOf(spaceUri);
      if (space === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${spaceUri} is not a space address`),
        );
      }
      const held = yield* deps.spaces
        .meta(spaceUri)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${spaceUri} on this host`),
        );
      }
      const archive = yield* parseSpaceMetaStar(held.value).pipe(
        Effect.mapError(() => serverError('the stored space does not parse')),
      );
      const policy = yield* decodePolicy(archive.policy).pipe(
        Effect.mapError(() =>
          serverError('the stored space policy does not parse'),
        ),
      );
      const did = didOf(callerDid);
      const entry = archive.policyState.find(
        (one) => one.key === `${MEMBER_STATE_PREFIX}${callerDid}`,
      );
      const member: MemberAccess | undefined =
        entry === undefined
          ? undefined
          : Option.getOrUndefined(
              Schema.decodeUnknownOption(MemberAccess)(entry.value),
            );
      const verdict = decideWrite({
        policy,
        did,
        authority: space.authority,
        member,
      });
      yield* Match.value(verdict).pipe(
        Match.tag('Allow', () => Effect.void),
        Match.tag('Deny', (denied) =>
          Effect.fail(
            forbidden(
              `the ${policy.$type} does not let ${callerDid} write here: ${denied.reason}`,
            ),
          ),
        ),
        Match.tag('Ask', () =>
          Effect.gen(function* () {
            // `decideWrite` answers Ask only for the managed policy - the one that carries an app.
            if (
              policy.$type !== MANAGED_POLICY_TYPE ||
              deps.identity === undefined
            ) {
              return yield* Effect.fail(
                forbidden(
                  `a ${policy.$type} defers writes to its managing app, and this host has no identity resolver to reach it`,
                ),
              );
            }
            const verdict = yield* askManagingApp({
              managingApp: policy.managingApp,
              authority: space.authority,
              space: spaceUri,
              did: callerDid,
              access: 'write',
              // A write check carries no client: `notifyWrite` does not identify the app that
              // originated the write, so there is nothing attested to pass.
              signingKey: deps.config.signingKey,
              identity: deps.identity,
              now: Date.now(),
            });
            return yield* Match.value(verdict).pipe(
              Match.tag('Allow', () => Effect.void),
              Match.tag('Deny', (denied) =>
                Effect.fail(
                  forbidden(
                    `the ${MANAGED_POLICY_TYPE} asked ${policy.managingApp} whether ${callerDid} may write in ${spaceUri}: ${denied.detail} [${denied.reason}]`,
                  ),
                ),
              ),
              Match.exhaustive,
            );
          }),
        ),
        Match.exhaustive,
      );
      const ref: SpaceRepoRef = {
        space: Schema.decodeSync(ATURI)(spaceUri),
        did,
      };
      return { ref, policy };
    });

  /**
   * Write the policy's **publication records** into the authority's repo in the space.
   *
   * The configuration is the truth (`space-host/src/policy.ts`): the policy and the member list live
   * in the meta archive, and these records are a copy for readers — only the ones the policy asked to
   * publish (`publishPolicy`, `publishMembers`). They are ordinary records, so they ride the same log,
   * the same export and the same gate as everything else.
   *
   * A reconcile, not an append: an entry the policy no longer publishes is **deleted**, because a
   * removed member left behind as a record is the stale access this exists to prevent. Only the two
   * publication collections are read, so a record the authority wrote by hand elsewhere is never
   * swept. Nothing here is atomic with the archive write that triggered it — a failure leaves the
   * copy behind and the next member change repairs it.
   */
  const publish = (params: { space: string; archive: SpaceMetaArchive }) =>
    Effect.gen(function* () {
      const space = spaceOf(params.space);
      if (space === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${params.space} is not a space address`),
        );
      }
      const policy = yield* decodePolicy(params.archive.policy).pipe(
        Effect.mapError(() =>
          serverError('the stored space policy does not parse'),
        ),
      );
      const members = new Map<DID, MemberAccess>();
      for (const entry of params.archive.policyState) {
        if (!entry.key.startsWith(MEMBER_STATE_PREFIX)) {
          continue;
        }
        const access = Option.getOrUndefined(
          Schema.decodeUnknownOption(MemberAccess)(entry.value),
        );
        if (access === undefined) {
          continue;
        }
        members.set(didOf(entry.key.slice(MEMBER_STATE_PREFIX.length)), access);
      }
      const policyRecord = policyRecordOf(policy);
      const desired = [
        ...(policyRecord === undefined ? [] : [policyRecord]),
        ...memberRecordsOf({ policy, members }),
      ];
      // The record carries its own `$type`, which is the collection: the archive's copy is a value,
      // a record is a value plus what it is.
      const wanted = new Map<
        string,
        { collection: string; rkey: string; value: Schema.Json }
      >();
      for (const record of desired) {
        wanted.set(`${record.collection}/${record.rkey}`, {
          collection: String(record.collection),
          rkey: String(record.rkey),
          value: {
            $type: String(record.collection),
            ...record.value,
          } as Schema.Json,
        });
      }

      const ref: SpaceRepoRef = {
        space: Schema.decodeSync(ATURI)(params.space),
        did: didOf(space.authority),
      };
      const published = new Set([
        String(POLICY_RECORD_COLLECTION),
        String(MEMBER_RECORD_COLLECTION),
      ]);
      const state = yield* stateOf(ref);
      const rev = yield* revOf();
      const ops: Array<SpaceRecordOp> = [];
      for (const [path, want] of wanted) {
        const bytes = yield* bytesOfRecord(want.value);
        const current = state.get(path);
        if (
          current !== undefined &&
          current.value !== undefined &&
          sameBytes(current.value, bytes)
        ) {
          continue;
        }
        ops.push({
          space: ref.space,
          collection: Schema.decodeSync(NSID)(want.collection),
          rkey: Schema.decodeSync(RecordKey)(want.rkey),
          action: current === undefined ? 'create' : 'update',
          ...(current === undefined ? {} : { prevCid: current.cid }),
          cid: yield* cidOf(bytes),
          rev: Schema.decodeSync(TID)(rev),
          author: ref.did,
          signature: new Uint8Array(),
          value: bytes,
        });
      }
      for (const [path, head] of state) {
        const collection = path.slice(0, path.indexOf('/'));
        if (!published.has(collection) || wanted.has(path)) {
          continue;
        }
        ops.push({
          space: ref.space,
          collection: Schema.decodeSync(NSID)(collection),
          rkey: Schema.decodeSync(RecordKey)(path.slice(collection.length + 1)),
          action: 'delete',
          prevCid: head.cid,
          cid: yield* deleteCidOf(path, rev),
          rev: Schema.decodeSync(TID)(rev),
          author: ref.did,
          signature: new Uint8Array(),
        });
      }
      if (ops.length > 0) {
        yield* commitOps(ref, ops);
      }
    });

  /**
   * Tell the space's own stream what just landed, one frame per operation.
   *
   * A permissioned space's writes never go on the public firehose, so a reader of the space hears them
   * here instead of polling. Best effort: with no firehose there are no subscribers, and a frame that
   * was not delivered — or could not be built — is one `listRecords` away.
   */
  const notifySpace = (
    ref: SpaceRepoRef,
    ops: ReadonlyArray<SpaceRecordOp>,
  ): Effect.Effect<void> => {
    const firehose = deps.firehose;
    if (firehose === undefined) {
      return Effect.void;
    }
    const now = new Date();
    return Effect.forEach(
      ops,
      (op, index) =>
        firehose.emitSpace({
          time: now.toISOString(),
          // One microsecond apart, so two operations in one commit keep their order.
          timeUs: now.getTime() * 1000 + index,
          space: String(ref.space),
          did: String(ref.did),
          rev: String(op.rev),
          action: op.action,
          collection: String(op.collection),
          rkey: String(op.rkey),
          cid: String(op.cid),
          ...(op.value === undefined
            ? {}
            : { value: toJson(decodeCbor(op.value)) }),
        }),
      { discard: true },
    ).pipe(Effect.catchCause(() => Effect.void));
  };

  /**
   * Commit a batch under a fresh epoch, on the head read just before it.
   *
   * The one place a write lands, so it is also the one place the stream is told: a caller cannot
   * forget to announce, and the announce happens after the log's CAS accepted the batch, never before.
   * `announce: false` is for a whole-repo import (`importRepo`): it is a replay of a repo a reader
   * gets from `getRepo`, not a new write to tail.
   */
  const commitOps = (
    ref: SpaceRepoRef,
    ops: ReadonlyArray<SpaceRecordOp>,
    options?: { readonly announce?: boolean },
  ) =>
    Effect.gen(function* () {
      const { log, lock } = deps.writes;
      const epoch = yield* lock.acquire(ref.space);
      const base = yield* log.head(ref);
      const appended = yield* log
        .appendBatch(ref, ops, { base, epoch })
        .pipe(Effect.mapError(logFailure));
      if (options?.announce !== false) {
        yield* notifySpace(ref, ops);
      }
      return appended;
    });

  /**
   * The bulk clear: one entry, an empty repo at `rev`. A repo with no log at
   * all is already empty, so nothing is appended and no revision is invented.
   */
  const appendClear = (ref: SpaceRepoRef, force = false) =>
    Effect.gen(function* () {
      const { log, lock } = deps.writes;
      const entries = yield* entriesOf(ref);
      // A repo with no log is already empty; `force` records an empty repo
      // that must exist (an import of an empty archive). A repo that exists
      // and already folds to nothing is a no-op clear: no new revision.
      if (entries.length === 0) {
        if (!force) {
          return false;
        }
      } else if (foldState(entries).size === 0) {
        return false;
      }
      const epoch = yield* lock.acquire(ref.space);
      const base = yield* log.head(ref);
      const rev = yield* revOf();
      const data = yield* ltHashDigestOf([]).pipe(
        Effect.mapError(() => serverError('the empty digest was not made')),
      );
      const op: SpaceClearOp = {
        space: ref.space,
        action: 'clear',
        rev: Schema.decodeSync(TID)(rev),
        author: ref.did,
        signature: new Uint8Array(),
        data,
      };
      yield* log
        .clear(ref, op, { base, epoch })
        .pipe(Effect.mapError(logFailure));
      return true;
    });

  /**
   * Read, change and write a space's archive — the one place membership lives.
   *
   * The write is a compare-and-swap on the version that was read, so two member changes racing cannot
   * lose one: the loser is refused by `Kv` and told to retry rather than overwriting the winner. An
   * `edit` that answers `undefined` changed nothing, which is how removing somebody who is not a
   * member stays a no-op instead of becoming a revision.
   */
  const editSpaceMeta = (params: {
    readonly space: string;
    readonly authority: string;
    readonly edit: (
      archive: SpaceMetaArchive,
    ) => Effect.Effect<SpaceMetaArchive | undefined, XrpcError>;
  }): Effect.Effect<SpaceMetaArchive | undefined, XrpcError> =>
    Effect.gen(function* () {
      const held = yield* deps.spaces
        .metaVersioned(params.space)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${params.space} on this host`),
        );
      }
      const archive = yield* parseSpaceMetaStar(held.value.value).pipe(
        Effect.mapError(() => serverError('the stored space does not parse')),
      );
      const next = yield* params.edit(archive);
      if (next === undefined) {
        return undefined;
      }
      const bytes = yield* encodeSpaceMetaStar(next).pipe(
        Effect.mapError(() =>
          serverError('the space archive could not be written'),
        ),
      );
      // The archive is canonical CBOR, so an edit that changed nothing encodes to the bytes that were
      // read: a retried update or a re-added member is not a revision.
      if (sameBytes(held.value.value, bytes)) {
        return undefined;
      }
      // `Result`, not `catchTag`: the refusal has to survive as a 409 while every other store error
      // becomes a 500, and a combinator that catches both cannot tell them apart afterwards.
      const stored = yield* Effect.result(
        deps.spaces.replaceMeta({
          space: params.space,
          authority: params.authority,
          archive: bytes,
          expected: held.value.version,
        }),
      );
      if (Result.isFailure(stored)) {
        return yield* Effect.fail(
          Predicate.isTagged(stored.failure, 'KeyPreconditionFailed')
            ? conflict(
                'SpaceChanged',
                `the space ${params.space} changed while it was being edited; retry`,
              )
            : serverError('the space could not be stored'),
        );
      }
      return next;
    });

  server.method('com.atproto.space.listSpaces', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(LIST_SPACES_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listSpaces'));
      }
      const input = decoded.value;
      const limit = limitOf(input.limit, 50, 100);
      const authority = yield* deps.spaces
        .authorityOf(caller.account.did)
        .pipe(
          Effect.mapError(() => serverError('the spaces could not be read')),
        );
      const held = yield* deps.spaces
        .heldBy(caller.account.did)
        .pipe(
          Effect.mapError(() => serverError('the spaces could not be read')),
        );
      // The lexer's "spaces the account is the authority of, or holds a repo
      // in", with the optional filters applied before the page.
      const all = [...new Set([...authority, ...held])]
        .filter((uri) => {
          const parsed = spaceOf(uri);
          if (parsed === undefined) {
            return false;
          }
          return (
            (input.spaceType === undefined ||
              parsed.type === input.spaceType) &&
            (input.did === undefined || parsed.authority === input.did)
          );
        })
        .sort();
      const after = input.cursor;
      const from = after === undefined ? all : all.filter((uri) => uri > after);
      const page = from.slice(0, limit);
      const cursor = page.at(-1);
      return {
        spaces: page.map((uri) => ({ uri })),
        ...(from.length > limit && cursor !== undefined ? { cursor } : {}),
      };
    }),
  );

  /**
   * The authority hands an approved app a credential for one space (`frxd`, spaces `0016`).
   *
   * Only the authority mints: a space's policy is its own decision, and a member asking on an
   * app's behalf is a different flow (the app calls, the member consents) that this host does not
   * speak yet. `allowedApps` is asked **explicitly** — `decideRead` short-circuits for the
   * authority, which is right for a read and wrong for handing a token to somebody else.
   *
   * The token is bound to the app's DPoP key (`jkt`), so a minted credential is useless to anyone
   * who does not hold that key: the caller may name any `jkt`, and only its owner can use it.
   */
  server.method('com.atproto.space.getCredential', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(CREDENTIAL_INPUT)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getCredential'));
      }
      const input = decoded.value;
      const space = spaceOf(input.space);
      if (space === undefined) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${input.space}`),
        );
      }
      const held = yield* deps.spaces
        .meta(input.space)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${input.space} on this host`),
        );
      }
      const archive = yield* parseSpaceMetaStar(held.value).pipe(
        Effect.mapError(() => serverError('the stored space does not parse')),
      );
      const policy = yield* decodePolicy(archive.policy).pipe(
        Effect.mapError(() =>
          serverError('the stored space policy does not parse'),
        ),
      );
      const now = Date.now();

      // Two ways in: the authority's own session, or the app proving it holds the key its DID
      // publishes. The second is how an app with no account on this host asks for its own
      // credential; a forged claim only sends the signature check to the wrong key.
      const session = yield* authenticateAccess(deps, ctx).pipe(Effect.option);
      const token = bearer(ctx);

      if (Option.isSome(session)) {
        if (space.authority !== session.value.account.did) {
          return yield* Effect.fail(
            notFound('SpaceNotFound', `no space ${input.space} for you`),
          );
        }
      } else {
        if (token === undefined || deps.appKeys === undefined) {
          return yield* Effect.fail(
            unauthorized('a session, or a proof signed by an approved app'),
          );
        }
        const claimed = appOfProofUnverified(token);
        if (claimed === undefined) {
          return yield* Effect.fail(unauthorized('the proof names no app'));
        }
        const key = yield* deps
          .appKeys(claimed)
          .pipe(
            Effect.mapError(() => serverError('the app key could not be read')),
          );
        if (key === undefined) {
          return yield* Effect.fail(
            unauthorized(`no key is published for ${claimed}`),
          );
        }
        const verdict = yield* verifyAppProof({
          proof: token,
          key,
          audience: deps.config.did,
          now,
        });
        if (!verdict.ok) {
          return yield* Effect.fail(unauthorized(verdict.reason));
        }
        if (verdict.proof.iss !== claimed) {
          return yield* Effect.fail(unauthorized('the proof changed its mind'));
        }
      }

      if (!appApproved(policy, input.app)) {
        return yield* Effect.fail(
          forbidden(`${input.app} is not an app this space allows`),
        );
      }
      const authority = yield* Schema.decodeUnknownEffect(DID)(
        space.authority,
      ).pipe(
        Effect.mapError(() => serverError('the space names no authority')),
      );

      // The reader is whoever asks: the authority's session, or the app itself.
      const reader = Option.isSome(session)
        ? yield* Schema.decodeUnknownEffect(DID)(
            session.value.account.did,
          ).pipe(Effect.mapError(() => serverError('the caller is not a DID')))
        : yield* Schema.decodeUnknownEffect(DID)(input.app).pipe(
            Effect.mapError(() => serverError('the app is not a DID')),
          );

      const verdict = yield* credentialFor({
        policy,
        did: reader,
        authority,
        // The token is for this host, which is what verifies it; the authority is the issuer.
        audience: deps.config.did,
        member: undefined,
        app: input.app,
        space: input.space,
        jkt: input.jkt,
        key: deps.config.signingKey,
        now,
      });
      if (!verdict.ok) {
        return yield* Effect.fail(
          forbidden(`no credential: ${verdict.reason}`),
        );
      }
      return {
        token: verdict.token,
        exp: Math.floor(now / 1000) + SPACE_CREDENTIAL_TTL_SECONDS,
      };
    }),
  );

  server.method('com.atproto.space.getSpace', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getSpace'));
      }
      const uri = decoded.value.space;
      const space = spaceOf(uri);
      // A space credential is not accepted and a non-owner learns nothing:
      // the reference answers SpaceNotFound rather than UserNotAuthorized.
      if (space === undefined || space.authority !== caller.account.did) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${uri} for you`),
        );
      }
      const held = yield* deps.spaces
        .meta(uri)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${uri} on this host`),
        );
      }
      const archive = yield* parseSpaceMetaStar(held.value).pipe(
        Effect.mapError(() => serverError('the stored space does not parse')),
      );
      const policy = yield* decodePolicy(archive.policy).pipe(
        Effect.mapError(() =>
          serverError('the stored space policy does not parse'),
        ),
      );
      return { uri, policy };
    }),
  );

  /**
   * One grant decision, for a service that fronts the same space (`ie14`): the
   * git gateway holds bytes, the PDS holds the grants, so the gateway asks
   * instead of keeping a second copy of the space log.
   *
   * Fail-closed both ways: a space that is not one, a caller with no grant and a
   * lookup that cannot answer all read as `allow: false`, and the caller decides
   * what to do. The reason is the evaluator's own, for a member asking about
   * their own access.
   */
  server.method('com.atproto.space.checkAccess', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(CHECK_ACCESS_PARAM)(
        ctx.params,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for checkAccess'));
      }
      const { space, action, collection } = decoded.value;
      if (spaceOf(space) === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${space} is not a space address`),
        );
      }
      const decision = yield* checkAccess({
        space: Schema.decodeSync(ATURI)(space),
        did: Schema.decodeSync(DID)(caller.account.did),
        action,
        ...(collection === undefined
          ? {}
          : { collection: Schema.decodeSync(NSID)(collection) }),
      }).pipe(Effect.provide(grantLayers));
      return Match.value(decision).pipe(
        Match.tag('Allow', () => ({ allow: true })),
        Match.tag('Deny', (denied) => ({
          allow: false,
          reason: denied.reason,
        })),
        Match.exhaustive,
      );
    }),
  );

  server.method('com.atproto.space.createSpace', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(CREATE_SPACE_INPUT)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createSpace'));
      }
      const input = decoded.value;
      const did = caller.account.did;
      // A key is a record key, so the same syntax and the same ceiling; absent, it is a TID, which is
      // what makes `createSpace` usable without the caller inventing a name.
      const skey =
        input.skey ??
        (yield* nextTid({
          now: Date.now(),
          clockId: deps.config.clockId,
        }).pipe(
          Effect.mapError(() => serverError('a space key was not made')),
        ));
      const uri = `at://${did}/${input.spaceType}/${skey}`;
      // The address has to be one: this is also where an NSID that is not one and a key with a `/`
      // in it are refused, rather than becoming a row nothing can address.
      const space = spaceOf(uri);
      if (space === undefined || space.authority !== did) {
        return yield* Effect.fail(
          invalid(
            'a space is at://<your did>/<nsid>/<key>, and the key is a record key',
          ),
        );
      }
      // The policy is the whole of what a space *is*: a `$type` this host does not implement would be
      // a space whose access no code here can answer, so it is refused before anything is written.
      const policy = yield* decodePolicy(input.policy).pipe(
        Effect.mapError(() =>
          notFound(
            'UnsupportedPolicy',
            'the policy is not one this host implements',
          ),
        ),
      );
      const held = yield* deps.spaces
        .meta(uri)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isSome(held)) {
        return yield* Effect.fail(
          notFound('SpaceAlreadyExists', `the space ${uri} is here already`),
        );
      }
      // An empty space is an archive with its policy and nothing else: the same shape an import
      // produces, so `getSpace` and an export cannot tell a created space from a received one.
      const archive = yield* encodeSpaceMetaStar({
        meta: { $type: SPACE_META_STAR, ver: SPACE_META_VER, space: uri },
        policy: policyValue(policy),
        policyState: [],
        writers: [],
      }).pipe(
        Effect.mapError(() =>
          serverError('the space archive could not be written'),
        ),
      );
      yield* deps.spaces
        .putMeta({ space: uri, authority: did, archive })
        .pipe(
          Effect.mapError(() => serverError('the space could not be stored')),
        );
      return { uri };
    }),
  );

  /**
   * `com.atproto.space.updateSpace`: the policy, replaced wholesale.
   *
   * `space-host/src/policy.ts` decides what survives. A same-`$type` change is a configuration change
   * and keeps the policy state — a member list does not vanish because `publicWrite` flipped. A
   * different `$type` is a **migration** and discards it, because the release says a member list does
   * not come back on migrating back, and keeping one would promise a return we cannot make. The
   * writer set is only "may" be re-evaluated and is left alone.
   *
   * Publication follows from the same reconcile as a member change: a policy that stops publishing
   * loses its record, a migration loses its member records, and a switch that starts publishing gains
   * them.
   *
   * The policy is also the only thing that can take an app's access away short of deleting the space,
   * and a credential lives two hours: so the apps this authority reads by are told what the policy
   * now is, and one the new policy no longer names drops its copies (`frxd`, `p6wp`).
   */
  server.method('com.atproto.space.updateSpace', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(UPDATE_SPACE_INPUT)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for updateSpace'));
      }
      const input = decoded.value;
      const space = yield* requireAuthority(caller.account.did, input.space);
      const policy = yield* decodePolicy(input.policy).pipe(
        Effect.mapError(() =>
          notFound(
            'UnsupportedPolicy',
            'the policy is not one this host implements',
          ),
        ),
      );
      const next = yield* editSpaceMeta({
        space: input.space,
        authority: space.authority,
        edit: (archive) =>
          Effect.gen(function* () {
            const previous = yield* decodePolicy(archive.policy).pipe(
              Effect.mapError(() =>
                serverError('the stored space policy does not parse'),
              ),
            );
            return {
              ...archive,
              policy: policyValue(policy),
              policyState: policyStateSurvives(previous, policy)
                ? archive.policyState
                : [],
            };
          }),
      });
      if (next !== undefined) {
        yield* publish({ space: input.space, archive: next });
        // The apps that were reading it may no longer be named: say what the policy is now, and let
        // a receiver it does not approve drop what it copied.
        if (deps.spaceHooks !== undefined) {
          yield* deps.spaceHooks.notify({
            space: input.space,
            authority: space.authority,
            action: 'updated',
            policy,
          });
        }
      }
      return {};
    }),
  );

  server.method('com.atproto.space.deleteSpace', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_PARAM)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for deleteSpace'));
      }
      const uri = decoded.value.space;
      const space = spaceOf(uri);
      if (space === undefined || space.authority !== caller.account.did) {
        return yield* Effect.fail(
          notFound('NotSpaceOwner', `${uri} is not yours to delete`),
        );
      }
      const held = yield* deps.spaces
        .meta(uri)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${uri} on this host`),
        );
      }
      // The space stops existing, and the owner's own repo in it goes with it: its log is cleared.
      // A member's repo is the member's: it stays, and its hold row keeps `listSpaces` naming the
      // space for them until the space host tells them otherwise (that notification is the grant
      // layer's, not this).
      yield* appendClear({
        space: Schema.decodeSync(ATURI)(uri),
        did: didOf(space.authority),
      });
      yield* deps.spaces
        .forgetHold({ space: uri, did: space.authority })
        .pipe(
          Effect.mapError(() =>
            serverError('the space could not be forgotten'),
          ),
        );
      yield* deps.spaces
        .deleteMeta({ space: uri, authority: space.authority })
        .pipe(
          Effect.mapError(() => serverError('the space could not be deleted')),
        );
      // The space is gone, and a reader's copies of it are not the reader's to keep: say so.
      // Nobody answering is not a failed delete — the delete already happened.
      if (deps.spaceHooks !== undefined) {
        yield* deps.spaceHooks.notify({
          space: uri,
          authority: space.authority,
          action: 'revoked',
        });
      }
      return {};
    }),
  );

  /**
   * `com.atproto.memberspace.putMember`: the authority's member list.
   *
   * Membership is policy **state**, not a record (`space-host/src/policy.ts`): the archive carries
   * it, `decideWrite` reads exactly `member/<did>` out of it, and `exportSpaceMeta` hands the same
   * bytes to a mover. So a change edits the archive under a version condition, rather than writing a
   * record that a second source of truth would then have to agree with.
   *
   * `write: false` also prunes the writer set: an account that may not write must not stay listed as
   * one that does. The entry comes back when it next writes while still authorized, which is what
   * proposal#128 means by "tracked again if it later writes".
   *
   * `read` is the policy's own answer to "may this member read the space": `mayRead` asks
   * `decideSessionRead` about it before it asks for a grant, so a memberspace reads without one. (A
   * credential is still minted only by the authority, and `decideRead`'s `allowedApps` is a question
   * about apps, not about a person with a session.)
   */
  server.method('com.atproto.memberspace.putMember', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(PUT_MEMBER_INPUT)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for putMember'));
      }
      const input = decoded.value;
      const space = yield* requireAuthority(caller.account.did, input.space);
      const member = yield* memberDidOf(input.did);
      const next = yield* editSpaceMeta({
        space: input.space,
        authority: space.authority,
        edit: (archive) =>
          Effect.gen(function* () {
            const policy = yield* decodePolicy(archive.policy).pipe(
              Effect.mapError(() =>
                serverError('the stored space policy does not parse'),
              ),
            );
            if (policy.$type !== MEMBER_POLICY_TYPE) {
              return yield* Effect.fail(
                invalid(
                  `a ${policy.$type} keeps no member list; only ${MEMBER_POLICY_TYPE} has members`,
                ),
              );
            }
            return {
              ...archive,
              policyState: [
                ...archive.policyState.filter(
                  (one) => one.key !== memberKey(member),
                ),
                {
                  key: memberKey(member),
                  value: { read: input.read, write: input.write },
                },
              ],
              writers: input.write
                ? archive.writers
                : archive.writers.filter((one) => one.did !== member),
            };
          }),
      });
      if (next !== undefined) {
        yield* publish({ space: input.space, archive: next });
      }
      return {};
    }),
  );

  /**
   * `com.atproto.memberspace.removeMember`: the entry and the writer-set row go together.
   *
   * Idempotent, and a no-op is not a revision: removing somebody who is not a member writes nothing,
   * so a retried removal cannot churn the archive a mover then has to carry.
   */
  server.method('com.atproto.memberspace.removeMember', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_MEMBER_PARAM)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for removeMember'));
      }
      const input = decoded.value;
      const space = yield* requireAuthority(caller.account.did, input.space);
      const member = yield* memberDidOf(input.did);
      const next = yield* editSpaceMeta({
        space: input.space,
        authority: space.authority,
        edit: (archive) => {
          const policyState = archive.policyState.filter(
            (one) => one.key !== memberKey(member),
          );
          const writers = archive.writers.filter((one) => one.did !== member);
          if (
            policyState.length === archive.policyState.length &&
            writers.length === archive.writers.length
          ) {
            return Effect.succeed(undefined);
          }
          return Effect.succeed({ ...archive, policyState, writers });
        },
      });
      if (next !== undefined) {
        yield* publish({ space: input.space, archive: next });
      }
      return {};
    }),
  );

  /**
   * `com.atproto.space.getAccess`: what **the caller** is in this space.
   *
   * The one question a member could not ask. Grants are records in the authority's repo, so reading
   * one needs a grant over `ing.lexicon.grant`, and the member publication sits behind the same gate
   * (`anpp`). This answers without opening either, and it names no DID: it cannot be asked about
   * somebody else.
   *
   * A view over what is already there, not a second grant store — `checkAccess` still decides what an
   * action may do. This says what exists, which is what a client needs to render "what may I do here"
   * instead of guessing and being refused.
   *
   * Only a host that holds the archive can answer, because the member list is the authority's state:
   * a member whose PDS is not the space's host is told `SpaceNotFound` and asks the host that serves
   * it.
   */
  server.method('com.atproto.space.getAccess', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_PARAM)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getAccess'));
      }
      const input = decoded.value;
      const space = spaceOf(input.space);
      if (space === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${input.space} is not a space address`),
        );
      }
      const uri = Schema.decodeSync(ATURI)(input.space);
      const held = yield* deps.spaces
        .meta(input.space)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${input.space} on this host`),
        );
      }
      const archive = yield* parseSpaceMetaStar(held.value).pipe(
        Effect.mapError(() => serverError('the stored space does not parse')),
      );
      const state = yield* deps.writes.log
        .state({ space: uri, did: didOf(space.authority) })
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      const read = yield* grantsAndRevocations({
        state,
        space: uri,
        subjects: [didOf(caller.account.did)],
      }).pipe(
        Effect.mapError(() => serverError('the grants could not be read')),
      );
      const entry = archive.policyState.find(
        (one) => one.key === memberKey(caller.account.did),
      );
      const access =
        entry === undefined
          ? undefined
          : Option.getOrUndefined(
              Schema.decodeUnknownOption(MemberAccess)(entry.value),
            );
      return {
        space: input.space,
        did: caller.account.did,
        ...(access === undefined
          ? {}
          : { member: { read: access.read, write: access.write } }),
        grants: read.grants
          .map((row) => ({
            uri: row.ref.uri,
            cid: row.ref.cid,
            revoked: read.revocations.has(row.ref.uri),
            value: row.value,
          }))
          .sort((left, right) =>
            left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0,
          ),
      };
    }),
  );

  /**
   * `com.atproto.space.listRepos`: which accounts hold data in this space, **now**.
   *
   * Answering from the write log rather than from the archive is the point (`puls`): the archive's
   * `writers` is what an import arrived with, while `SWL/<space>/<did>/head` exists exactly for the
   * repos that have written. A syncer that resumes here gets the `rev` it needs to continue.
   *
   * Who may ask is the policy's own answer — the authority, a member with `read`, `publicRead` — or an
   * app the authority minted a credential for. A **grant does not buy this**: it names one collection
   * in one repo, and this answer is every repo in the space.
   */
  server.method('com.atproto.space.listRepos', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(SPACE_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listRepos'));
      }
      const input = decoded.value;
      const reader = yield* readerOf(ctx, input.space);
      const space = spaceOf(input.space);
      if (space === undefined) {
        return yield* Effect.fail(
          invalid(`the space ${input.space} is not a space address`),
        );
      }
      if (reader.kind === 'session') {
        const policy = yield* policyReadOf({
          space: input.space,
          authority: space.authority,
          did: reader.did,
        });
        if (policy.kind !== 'allow') {
          return yield* Effect.fail(
            forbidden(
              `the policy does not let ${reader.did} list the repos of ${input.space}: ${policy.reason}`,
            ),
          );
        }
      }
      const repos = yield* deps.writes.log.repos(
        Schema.decodeSync(ATURI)(input.space),
      );
      return { repos };
    }),
  );

  /**
   * `com.atproto.memberspace.listMembers`: the same state, read.
   *
   * The authority asks because it is the account editing it. A member reading its own access is the
   * publication's job (`publishMembers`), which is a record in the space and comes with the read
   * gate — not this handler, whose answer is every member.
   */
  server.method('com.atproto.memberspace.listMembers', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_PARAM)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listMembers'));
      }
      yield* requireAuthority(caller.account.did, decoded.value.space);
      const held = yield* deps.spaces
        .meta(decoded.value.space)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound(
            'SpaceNotFound',
            `no space ${decoded.value.space} on this host`,
          ),
        );
      }
      const archive = yield* parseSpaceMetaStar(held.value).pipe(
        Effect.mapError(() => serverError('the stored space does not parse')),
      );
      const members = archive.policyState
        .filter((one) => one.key.startsWith(MEMBER_STATE_PREFIX))
        .flatMap((one) => {
          const access = Option.getOrUndefined(
            Schema.decodeUnknownOption(MemberAccess)(one.value),
          );
          return access === undefined
            ? []
            : [
                {
                  did: one.key.slice(MEMBER_STATE_PREFIX.length),
                  read: access.read,
                  write: access.write,
                },
              ];
        })
        .sort((left, right) =>
          left.did < right.did ? -1 : left.did > right.did ? 1 : 0,
        );
      return { members };
    }),
  );

  server.method('com.atproto.space.importSpaceMeta', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const body = ctx.body;
      if (body === undefined || body.length === 0) {
        return yield* Effect.fail(
          invalid('importSpaceMeta takes a STAR archive as its body'),
        );
      }
      const checked = yield* validateSpaceMeta({
        bytes: body,
        callerDid: caller.account.did,
      });
      yield* deps.spaces
        .putMeta({
          space: checked.archive.meta.space,
          authority: checked.space.authority,
          archive: body,
        })
        .pipe(
          Effect.mapError(() =>
            serverError('the space archive could not be stored'),
          ),
        );
      return {};
    }),
  );

  server.method('com.atproto.space.exportSpaceMeta', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for exportSpaceMeta'));
      }
      const uri = decoded.value.space;
      const space = spaceOf(uri);
      if (space === undefined || space.authority !== caller.account.did) {
        return yield* Effect.fail(
          notFound('NotSpaceOwner', `the space ${uri} is not yours`),
        );
      }
      const held = yield* deps.spaces
        .meta(uri)
        .pipe(
          Effect.mapError(() => serverError('the space could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(
          notFound('SpaceNotFound', `no space ${uri} on this host`),
        );
      }
      return new Response(Uint8Array.from(held.value), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }),
  );

  server.method('com.atproto.space.importRepo', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const body = ctx.body;
      if (body === undefined || body.length === 0) {
        return yield* Effect.fail(
          invalid('importRepo takes a STAR archive as its body'),
        );
      }
      const verified = yield* verifyRepoStar(body);
      if (verified.valid === false) {
        return yield* Effect.fail(
          invalid(`that is not a space repo archive: ${verified.reason}`),
        );
      }
      const meta = verified.meta;
      if (meta.repo !== caller.account.did) {
        return yield* Effect.fail(
          invalid('the archive is not the authenticated account\u2019s repo'),
        );
      }
      const space = spaceOf(meta.space);
      if (space === undefined) {
        return yield* Effect.fail(invalid('the archive names no space'));
      }
      // The authority has to have brought the space itself first; a member's
      // repo can arrive without it because this host is not that space's host.
      if (space.authority === caller.account.did) {
        const held = yield* deps.spaces
          .meta(meta.space)
          .pipe(
            Effect.mapError(() => serverError('the space could not be read')),
          );
        if (Option.isNone(held)) {
          return yield* Effect.fail(
            notFound(
              'SpaceNotFound',
              `import the space meta for ${meta.space} first`,
            ),
          );
        }
      }
      const archive = yield* parseRepoStar(body).pipe(
        Effect.mapError(() =>
          invalid('that is not a space repo archive we can read'),
        ),
      );
      const records = yield* canonicalRecords(archive.records);
      const ref: SpaceRepoRef = {
        space: Schema.decodeSync(ATURI)(meta.space),
        did: didOf(meta.repo),
      };
      const entries = yield* entriesOf(ref);
      const state = foldState(entries);
      const written = new Set(records.map((record) => record.key));
      const rev = yield* revOf();
      const ops: Array<SpaceRecordOp> = [];
      // Replace, not append: anything the new archive does not carry is gone.
      // One batch, so an import either lands whole or leaves the log as it was;
      // a failed import is retried with the same bytes (section 5d).
      for (const [path, head] of state) {
        if (written.has(path)) {
          continue;
        }
        const at = path.indexOf('/');
        const collection = collectionOf(path.slice(0, at));
        const rkey = recordKeyOf(path.slice(at + 1));
        if (at <= 0 || collection === undefined || rkey === undefined) {
          return yield* Effect.fail(
            invalid(`the archive key ${path} is not a record path`),
          );
        }
        const cid = yield* deleteCidOf(path, rev);
        ops.push({
          space: ref.space,
          collection,
          rkey,
          action: 'delete',
          prevCid: head.cid,
          cid,
          rev: Schema.decodeSync(TID)(rev),
          author: ref.did,
          signature: new Uint8Array(),
        });
      }
      for (const record of records) {
        const at = record.key.indexOf('/');
        const collection = collectionOf(record.key.slice(0, at));
        const rkey = recordKeyOf(record.key.slice(at + 1));
        if (at <= 0 || collection === undefined || rkey === undefined) {
          return yield* Effect.fail(
            invalid(`the archive key ${record.key} is not a record path`),
          );
        }
        const current = state.get(record.key);
        const cid = yield* cidOf(record.value);
        ops.push({
          space: ref.space,
          collection,
          rkey,
          action: current === undefined ? 'create' : 'update',
          ...(current === undefined ? {} : { prevCid: current.cid }),
          cid,
          rev: Schema.decodeSync(TID)(rev),
          author: ref.did,
          signature: new Uint8Array(),
          value: record.value,
        });
      }
      if (ops.length > 0) {
        // An import is a replay of a repo, not a write to tail: silent, like `clearRecords`. A reader
        // that wants the repo asks `getRepo`, which is the whole archive rather than a stream of ops.
        yield* commitOps(ref, ops, { announce: false });
      } else {
        // An empty archive is an empty repo: a `clear` entry is how the log
        // says "this repo exists and holds nothing", at a fresh revision.
        yield* appendClear(ref, true);
      }
      yield* deps.spaces
        .recordHold({ space: meta.space, did: meta.repo })
        .pipe(
          Effect.mapError(() => serverError('the space could not be recorded')),
        );
      return {};
    }),
  );

  server.method('com.atproto.space.getRepo', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(SPACE_REPO_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getRepo'));
      }
      const input = decoded.value;
      const reader = yield* readerOf(ctx, input.space);
      if (reader.kind === 'session') {
        yield* requireOwnRepo(reader.did, input.repo);
      }
      const ref = yield* refOf(input.space, input.repo);
      const entries = yield* requireRepo(ref);
      const rev = entries.at(-1)?.rev;
      if (rev === undefined) {
        return yield* Effect.fail(serverError('the repo has no revision'));
      }
      const bytes = yield* repoStarOf({ ref, rev });
      return new Response(Uint8Array.from(bytes), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }),
  );

  server.method('com.atproto.space.getLatestCommit', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_REPO_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getLatestCommit'));
      }
      const input = decoded.value;
      yield* requireOwnRepo(caller.account.did, input.repo);
      const ref = yield* refOf(input.space, input.repo);
      const entries = yield* requireRepo(ref);
      const rev = entries.at(-1)?.rev;
      if (rev === undefined) {
        return yield* Effect.fail(serverError('the repo has no revision'));
      }
      const records = yield* recordsOf(ref);
      const data = yield* dataOf(records);
      return {
        commit: {
          ver: SPACE_COMMIT_VER,
          repo: input.repo,
          space: input.space,
          rev,
          data: { $bytes: Buffer.from(data).toString('base64') },
        },
      };
    }),
  );

  server.method('com.atproto.space.createRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(CREATE_RECORD_INPUT)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createRecord'));
      }
      const input = decoded.value;
      yield* requireOwnRepo(caller.account.did, input.repo);
      const { ref } = yield* authorizeWrite(input.space, caller.account.did);
      const record = input.record;
      if (
        typeof record !== 'object' ||
        record === null ||
        Array.isArray(record)
      ) {
        return yield* Effect.fail(invalid('a record must be an object'));
      }
      const type = Object.entries(record).find(([key]) => key === '$type')?.[1];
      if (typeof type !== 'string') {
        return yield* Effect.fail(
          invalid('a record must contain a $type field'),
        );
      }
      const rkey = input.rkey ?? (yield* revOf());
      const collection = Schema.decodeUnknownOption(NSID)(input.collection);
      if (Option.isNone(collection)) {
        return yield* Effect.fail(invalid('the collection is not an NSID'));
      }
      const recordKey = Schema.decodeUnknownOption(RecordKey)(rkey);
      if (Option.isNone(recordKey)) {
        return yield* Effect.fail(invalid('the rkey is not a record key'));
      }
      const path = `${input.collection}/${rkey}`;
      const state = yield* stateOf(ref);
      if (state.has(path)) {
        return yield* Effect.fail(
          notFound(
            'RecordAlreadyExists',
            `a record already exists at ${path}; use applyWrites to update it`,
          ),
        );
      }
      const bytes = yield* bytesOfRecord(input.record);
      const cid = yield* cidOf(bytes);
      const rev = yield* revOf();
      const op: SpaceRecordOp = {
        space: ref.space,
        collection: collection.value,
        rkey: recordKey.value,
        action: 'create',
        cid,
        rev: Schema.decodeSync(TID)(rev),
        author: ref.did,
        signature: new Uint8Array(),
        value: bytes,
      };
      yield* commitOps(ref, [op]);
      return { uri: `at://${input.repo}/${input.collection}/${rkey}`, cid };
    }),
  );

  server.method('com.atproto.space.deleteRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(DELETE_RECORD_INPUT)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for deleteRecord'));
      }
      const input = decoded.value;
      yield* requireOwnRepo(caller.account.did, input.repo);
      const { ref } = yield* authorizeWrite(input.space, caller.account.did);
      const state = yield* stateOf(ref);
      const path = `${input.collection}/${input.rkey}`;
      const current = state.get(path);
      // A delete is idempotent: a missing record is a successful no-op, with
      // no new revision (the log only grows when something actually moved).
      if (current === undefined) {
        return {};
      }
      const collection = collectionOf(input.collection);
      const rkey = recordKeyOf(input.rkey);
      if (collection === undefined || rkey === undefined) {
        return yield* Effect.fail(invalid(`${path} is not a record path`));
      }
      const rev = yield* revOf();
      const cid = yield* deleteCidOf(path, rev);
      yield* commitOps(ref, [
        {
          space: ref.space,
          collection,
          rkey,
          action: 'delete',
          prevCid: current.cid,
          cid,
          rev: Schema.decodeSync(TID)(rev),
          author: ref.did,
          signature: new Uint8Array(),
        },
      ]);
      return {};
    }),
  );

  server.method('com.atproto.space.applyWrites', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(APPLY_WRITES_INPUT)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for applyWrites'));
      }
      const input = decoded.value;
      yield* requireOwnRepo(caller.account.did, input.repo);
      const { ref } = yield* authorizeWrite(input.space, caller.account.did);
      const now = Date.now();
      const rev = yield* revOf();
      // Plan against the state the batch itself builds, so an op that is
      // inconsistent with an earlier op in the same call is refused too.
      const provisional = new Map(yield* stateOf(ref));
      const ops: Array<SpaceRecordOp> = [];
      type WriteResult = {
        readonly $type: string;
        readonly uri?: string;
        readonly cid?: string;
      };
      const results: Array<WriteResult> = [];
      for (const [index, write] of input.writes.entries()) {
        const collection = Schema.decodeUnknownOption(NSID)(write.collection);
        if (Option.isNone(collection)) {
          return yield* Effect.fail(
            invalid(`write ${index} has no usable collection`),
          );
        }
        if (write.$type === 'com.atproto.space.applyWrites#delete') {
          const path = `${write.collection}/${write.rkey}`;
          const current = provisional.get(path);
          if (current === undefined) {
            return yield* Effect.fail(
              notFound('RecordNotFound', `no record ${path} to delete`),
            );
          }
          const rkey = recordKeyOf(write.rkey);
          if (rkey === undefined) {
            return yield* Effect.fail(
              invalid(`write ${index} has no usable record key`),
            );
          }
          const cid = yield* deleteCidOf(path, rev);
          ops.push({
            space: ref.space,
            collection: collection.value,
            rkey,
            action: 'delete',
            prevCid: current.cid,
            cid,
            rev: Schema.decodeSync(TID)(rev),
            author: ref.did,
            signature: new Uint8Array(),
          });
          provisional.delete(path);
          results.push({
            $type: 'com.atproto.space.applyWrites#deleteResult',
          });
          continue;
        }
        const rkey =
          write.rkey ??
          (yield* nextTid({
            now: now + index,
            clockId: deps.config.clockId,
          }).pipe(Effect.mapError(() => serverError('a key was not made'))));
        const path = `${write.collection}/${rkey}`;
        const current = provisional.get(path);
        const create = write.$type === 'com.atproto.space.applyWrites#create';
        if (create && current !== undefined) {
          return yield* Effect.fail(
            notFound(
              'RecordAlreadyExists',
              `a record already exists at ${path}`,
            ),
          );
        }
        if (!create && current === undefined) {
          return yield* Effect.fail(
            notFound('RecordNotFound', `no record ${path} to update`),
          );
        }
        const bytes = yield* bytesOfRecord(write.value);
        const cid = yield* cidOf(bytes);
        const recordKey = Schema.decodeUnknownOption(RecordKey)(rkey);
        if (Option.isNone(recordKey)) {
          return yield* Effect.fail(
            invalid(`write ${index} has no usable record key`),
          );
        }
        ops.push({
          space: ref.space,
          collection: collection.value,
          rkey: recordKey.value,
          action: create ? 'create' : 'update',
          ...(current === undefined ? {} : { prevCid: current.cid }),
          cid,
          rev: Schema.decodeSync(TID)(rev),
          author: ref.did,
          signature: new Uint8Array(),
          value: bytes,
        });
        provisional.set(path, {
          cid,
          rev: Schema.decodeSync(TID)(rev),
          author: ref.did,
          value: bytes,
        });
        results.push({
          $type: create
            ? 'com.atproto.space.applyWrites#createResult'
            : 'com.atproto.space.applyWrites#updateResult',
          uri: `at://${input.repo}/${write.collection}/${rkey}`,
          cid,
        });
      }
      if (ops.length > 0) {
        yield* commitOps(ref, ops);
      }
      return { results };
    }),
  );

  server.method('com.atproto.space.clearRecords', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(SPACE_REPO_PARAM)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for clearRecords'));
      }
      const input = decoded.value;
      yield* requireOwnRepo(caller.account.did, input.repo);
      // Clearing deletes your own records, so the write policy is the only
      // question: grants gate reads and other people's repos (`space-grants.ts`),
      // never your own, and the log is the repo's only truth.
      const { ref } = yield* authorizeWrite(input.space, caller.account.did);
      yield* appendClear(ref);
      return {};
    }),
  );

  server.method('com.atproto.space.listRecords', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(LIST_RECORDS_PARAM)(
        ctx.params,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listRecords'));
      }
      const input = decoded.value;
      const reader = yield* readerOf(ctx, input.space);
      yield* mayRead({
        reader,
        space: input.space,
        repo: input.repo,
        collection: input.collection,
      });
      const ref = yield* refOf(input.space, input.repo);
      yield* requireRepo(ref);
      const limit = limitOf(input.limit, 50, 1000);
      const state = yield* stateOf(ref);
      const held = [...state]
        .filter(
          ([key]) =>
            input.collection === undefined ||
            key.startsWith(`${input.collection}/`),
        )
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, head]) => ({ key, value: head.value }));
      const ordered = input.reverse === 'true' ? [...held].reverse() : held;
      const after = input.cursor;
      const from =
        after === undefined
          ? ordered
          : ordered.filter((record) =>
              input.reverse === 'true'
                ? record.key < after
                : record.key > after,
            );
      const page = from.slice(0, limit);
      const records = yield* Effect.forEach(page, (record) =>
        Effect.gen(function* () {
          if (record.value === undefined) {
            return yield* Effect.fail(
              serverError(`the record at ${record.key} has no bytes`),
            );
          }
          const at = record.key.indexOf('/');
          const collection = record.key.slice(0, at);
          const rkey = record.key.slice(at + 1);
          const digest = yield* sha256(record.value);
          return {
            collection,
            rkey,
            cid: formatCid(cidFromDigest({ codec: CODEC_DAG_CBOR, digest })),
            ...(input.excludeValues === 'true'
              ? {}
              : { value: toJson(yield* recordOf(record.value)) }),
          };
        }),
      );
      const cursor = page.at(-1)?.key;
      return {
        records,
        ...(from.length > limit && cursor !== undefined ? { cursor } : {}),
      };
    }),
  );

  server.method('com.atproto.space.getRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(SPACE_RECORD_PARAM)(
        ctx.params,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getRecord'));
      }
      const input = decoded.value;
      const reader = yield* readerOf(ctx, input.space);
      yield* mayRead({
        reader,
        space: input.space,
        repo: input.repo,
        collection: input.collection,
        rkey: input.rkey,
      });
      const ref = yield* refOf(input.space, input.repo);
      yield* requireRepo(ref);
      const path = `${input.collection}/${input.rkey}`;
      const found = (yield* stateOf(ref)).get(path);
      if (found === undefined || found.value === undefined) {
        return yield* Effect.fail(
          notFound('RecordNotFound', `no record ${path} in ${input.space}`),
        );
      }
      const digest = yield* sha256(found.value);
      return {
        uri: `at://${input.repo}/${input.collection}/${input.rkey}`,
        cid: formatCid(cidFromDigest({ codec: CODEC_DAG_CBOR, digest })),
        value: toJson(yield* recordOf(found.value)),
      };
    }),
  );

  server.method('com.atproto.space.listBlobs', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(LIST_BLOBS_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listBlobs'));
      }
      const input = decoded.value;
      const reader = yield* readerOf(ctx, input.space);
      const ref = yield* refOf(input.space, input.repo);
      yield* requireRepo(ref);
      // `since` filters a revision's changed blobs. This host keeps no
      // per-revision blob index, so it answers the full set - which is valid
      // for a migrator, and the only case this surface exists for.
      //
      // The list is the blobs of the records this reader may read: a blob has no collection or
      // record of its own, so it is visible exactly when something visible carries it. The owner and
      // an app credential answer without asking anyone, which is the migrator's path.
      const cids = new Set<string>();
      const state = yield* stateOf(ref);
      let visible = false;
      for (const [key, head] of state) {
        if (head.value === undefined) {
          continue;
        }
        const [collection, rkey] = key.split('/');
        const allowed = yield* mayReadQuietly({
          reader,
          space: input.space,
          repo: input.repo,
          ...(collection === undefined ? {} : { collection }),
          ...(rkey === undefined ? {} : { rkey }),
        });
        if (!allowed) {
          continue;
        }
        visible = true;
        const value: CborValue = yield* recordOf(head.value);
        for (const cid of blobCidsIn(value)) {
          cids.add(cid);
        }
      }
      // Nothing visible says why, the way the record surface would: an owner with no blobs at all
      // passes this and gets an empty page.
      if (!visible) {
        yield* mayRead({
          reader,
          space: input.space,
          repo: input.repo,
        });
      }
      const all = [...cids].sort();
      const limit = limitOf(input.limit, 500, 1000);
      const after = input.cursor;
      const from = after === undefined ? all : all.filter((cid) => cid > after);
      const page = from.slice(0, limit);
      const cursor = page.at(-1);
      return {
        cids: page,
        ...(from.length > limit && cursor !== undefined ? { cursor } : {}),
      };
    }),
  );

  server.method('com.atproto.space.getBlob', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(GET_BLOB_PARAM)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getBlob'));
      }
      const input = decoded.value;
      const reader = yield* readerOf(ctx, input.space);
      const ref = yield* refOf(input.space, input.repo);
      yield* requireRepo(ref);
      // A blob's identity is its bytes, so the store already holds them under
      // the uploading account; what a space adds is which CIDs its records
      // reference. A CID this repo does not name is not served from this space.
      //
      // A blob has no collection and no rkey, so a grant cannot name one. The honest rule is "a
      // record I may read carries it": the records that name this CID are what the gate is asked
      // about, and one of them allowing is enough — a collection grant answers all of them.
      const namers: Array<{
        readonly collection: string;
        readonly rkey: string;
      }> = [];
      const state = yield* stateOf(ref);
      for (const [key, head] of state) {
        if (head.value === undefined) {
          continue;
        }
        const value: CborValue = yield* recordOf(head.value);
        if (!blobCidsIn(value).includes(input.cid)) {
          continue;
        }
        const [collection, rkey] = key.split('/');
        if (collection !== undefined && rkey !== undefined) {
          namers.push({ collection, rkey });
        }
      }
      if (namers.length === 0) {
        return yield* Effect.fail(
          notFound('BlobNotFound', `no blob ${input.cid} in ${input.space}`),
        );
      }
      let allowed = false;
      for (const namer of namers) {
        if (
          yield* mayReadQuietly({
            reader,
            space: input.space,
            repo: input.repo,
            collection: namer.collection,
            rkey: namer.rkey,
          })
        ) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        return yield* Effect.fail(
          forbidden(
            `no grant covers a record carrying ${input.cid} in ${input.space}`,
          ),
        );
      }
      const payload = yield* deps.blobs
        .content(input.repo, input.cid)
        .pipe(Effect.mapError(() => serverError('the blob could not be read')));
      const meta = yield* deps.blobs
        .blob(input.repo, input.cid)
        .pipe(Effect.mapError(() => serverError('the blob could not be read')));
      if (Option.isNone(payload) || Option.isNone(meta)) {
        return yield* Effect.fail(
          notFound('BlobNotFound', `no blob ${input.cid} for ${input.repo}`),
        );
      }
      return new Response(Uint8Array.from(payload.value), {
        status: 200,
        headers: {
          'Content-Type': meta.value.mimeType,
          'Content-Length': String(meta.value.size),
        },
      });
    }),
  );

  /**
   * `com.atproto.space.subscribeRepos`: one space's writes, as JSON frames on a socket.
   *
   * The public firehose is public and a space's writes are not, so they are served here: the gate is
   * the one the record surface uses — a session or a credential, and then the policy's own answer —
   * and the frames are the records themselves, one per operation, because a space repo is a log and
   * not an MST and there is no CAR to hand out.
   *
   * The transport is a socket (`server.stream`), so a caller that may not read the space cannot be
   * answered with a status: it gets one `{"error": …}` frame and the socket closes. A cursor that
   * this host cannot resume from is the same shape, for the same reason.
   */
  if (deps.firehose !== undefined) {
    const firehose = deps.firehose;
    const frame = (
      value: SpaceCommitEvent | { error: string; message: string },
    ) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const refused = (message: string) =>
      Stream.make(frame({ error: 'NotAuthorized', message }));

    server.stream('com.atproto.space.subscribeRepos', {}, (ctx) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const space = ctx.params['space'] ?? '';
          const parsed = spaceOf(space);
          if (parsed === undefined) {
            return refused(`the space ${space} is not a space address`);
          }
          const reader = yield* Effect.result(readerOf(ctx, space));
          if (Result.isFailure(reader)) {
            return refused(reader.failure.message);
          }
          // A credential is scoped to one space by the authority that minted it, so it is its own
          // answer (`listRepos` asks the same way). A session is a person, and the policy says
          // whether that person may read.
          if (reader.success.kind === 'session') {
            const policy = yield* Effect.result(
              policyReadOf({
                space,
                authority: parsed.authority,
                did: reader.success.did,
              }),
            );
            if (Result.isFailure(policy)) {
              return refused(policy.failure.message);
            }
            if (policy.success.kind !== 'allow') {
              return refused(
                `the policy does not let ${reader.success.did} read ${space}: ${policy.success.reason}`,
              );
            }
          }
          const asked = ctx.params['cursor'];
          const cursor =
            asked === undefined || asked === '' ? undefined : Number(asked);
          const position = yield* Effect.result(firehose.cursorOf(cursor));
          if (Result.isFailure(position)) {
            return refused(String(position.failure));
          }
          return firehose
            .subscribeSpace({ space, cursor: position.success })
            .pipe(Stream.map(frame));
        }),
      ),
    );
  }
};
