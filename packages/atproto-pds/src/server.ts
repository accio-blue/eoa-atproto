import { Effect, Option } from 'effect';
import { type PdsConfig, notFound } from './pds.js';
import { type PluginMethod, registerPluginMethods } from './plugin-method.js';
import { SUBSCRIBE_NSID, subscribeReposHandler } from './subscribe.js';
import { type SpaceSurfaceDeps, type SpaceWrites } from './space.js';
import { XrpcError, createXrpcServer } from '@eoa/xrpc-server';
import { makeWriteLock, spaceWriteLogOverKv } from '@eoa/space-host';
import { type AccountStore } from './account-store.js';
import { type BlobStore } from './blob-store.js';
import { type DpopReplay } from './dpop-replay.js';
import { type Firehose } from './firehose.js';
import { type HandleDns } from './handle-dns.js';
import { type HandleTransportShape } from '@eoa/identity';
import { type Mail } from './mail.js';
import type { PluginHooks } from './repo.js';
import { RepoStore } from '@eoa/repo-store';
import { type SpaceStore } from './space-store.js';
import type { WebhookNotifier } from './webhook.js';
import { registerAccountMethods } from './account.js';
import { registerAdminMethods } from './admin.js';
import { registerBlobMethods } from './blob.js';
import { registerIdentityMethods } from './identity.js';
import { registerPrefsMethods } from './prefs.js';
import { registerRepoMethods } from './repo.js';
import { registerSpaceMethods } from './space.js';
import { registerSyncMethods } from './sync.js';

/**
 * The fresh PDS's surface (the Effect-PDS map, `96xr`).
 *
 * The transport is `@eoa/xrpc-server`, the store is `@eoa/kv`,
 * the repo model is `@eoa/repo-store` and the accounts are ours — shared
 * packages, not the old PDS: nothing is lifted (`i9h1`). The handlers close over
 * the *built* stores, because the transport runs a handler per request and a
 * request must not have to build one.
 *
 * Two methods live here because they are the server's own — who we are, and how
 * a repo is doing. The rest are three surfaces: `repo.*` (reads and writes over
 * the repo model), `server.*` (accounts, sessions, app passwords, invites),
 * `identity.*` (the handle, and what a client should publish for it), and the
 * blob methods (an upload, a fetch, a listing).
 */
export const createPdsServer = (params: {
  readonly config: PdsConfig;
  readonly repo: RepoStore['Service'];
  readonly accounts: AccountStore['Service'];
  readonly blobs: BlobStore['Service'];
  readonly replay: DpopReplay['Service'];
  readonly firehose: Firehose['Service'];
  readonly mail: Mail['Service'];
  /** The spaces surface's own rows: the meta archives and the spaces held. */
  readonly spaces: SpaceStore['Service'];
  /**
   * The per-(space, account) write log and its fence. Absent means this server
   * keeps space repos in memory - fine for a test or a single long-lived
   * process, gone on restart. A deployment that wants them to survive names
   * `spaceWriteLogKvLayer` and a lease-backed `WriteLock` here.
   */
  readonly spaceWrites?: SpaceWrites | undefined;
  /**
   * How an app's key is found when it asks for a credential without a session: a `did:web`
   * document, over the network in a deployment, from a map in a test (`frxd`).
   */
  readonly appKeys?: SpaceSurfaceDeps['appKeys'];
  /** Who to tell when a space is deleted (`frxd`); absent means nobody. */
  readonly spaceHooks?: SpaceSurfaceDeps['spaceHooks'];
  /**
   * How the authority resolves a managing app's `did#fragment` to an endpoint (`70cr`). A Worker
   * builds `new DefaultIdentityResolver()`; a rehearsal passes one whose document transport answers
   * from a map. Absent refuses every managed write, with that sentence.
   */
  readonly identity?: SpaceSurfaceDeps['identity'];
  /**
   * Where a handle's external answer is written (`a34b`) — `_atproto.<handle> TXT "did=…"`. Absent
   * means this deployment does not publish one: a host that answers `/.well-known/atproto-did` for
   * every name does not need it, and neither does an operator who writes records by hand.
   */
  readonly handleDns?: HandleDns | undefined;
  /**
   * How a handle outside this PDS's domain is checked — DoH and `/.well-known/atproto-did` by
   * default, which is what a Worker needs. A rehearsal binds it to a transport that answers for the
   * domains it invented (`bmsm`).
   */
  readonly handles?: HandleTransportShape | undefined;
  /** Told about every write, so a site's build can be nudged once per window. */
  readonly webhooks?: WebhookNotifier | undefined;
  /** The installed plugins a write is offered to (bean `395u`); a deployment composes them. */
  readonly plugins?: PluginHooks | undefined;
  /**
   * Methods a plugin adds (`cms-workspace`): authenticated here, reading the caller's own repo.
   * Absent means this host answers only the standard surface.
   */
  readonly methods?: ReadonlyArray<PluginMethod> | undefined;
}) => {
  const server = createXrpcServer();

  // The firehose is a stream rather than a method: it registers the same way,
  // and the transport routes the upgrade to it by path.
  server.stream(SUBSCRIBE_NSID, {}, subscribeReposHandler(params.firehose));

  server.method('com.atproto.server.describeServer', {}, () =>
    Effect.succeed({
      did: params.config.did,
      availableUserDomains: [params.config.domain],
      inviteCodeRequired: params.config.inviteCodeRequired ?? false,
      phoneVerificationRequired: false,
    }),
  );

  server.method('com.atproto.sync.getRepoStatus', {}, (ctx) =>
    Effect.gen(function* () {
      const did = ctx.params.did ?? '';
      const head = yield* params.repo
        .head(did)
        .pipe(Effect.mapError((error) => storeUnavailable(String(error))));
      if (Option.isNone(head)) {
        return yield* Effect.fail(
          notFound('RepoNotFound', `no repo for ${did}`),
        );
      }
      // The repo's health is the account's: a suspended account's repo is still
      // there, and it is not serving.
      const account = yield* params.accounts
        .account(did)
        .pipe(Effect.mapError((error) => storeUnavailable(String(error))));
      const status = Option.isNone(account) ? 'active' : account.value.status;
      return {
        did,
        active: status === 'active',
        status: status === 'suspended' ? 'suspended' : 'active',
        rev: head.value.rev,
      };
    }),
  );

  registerRepoMethods(server, {
    config: params.config,
    accounts: params.accounts,
    repo: params.repo,
    replay: params.replay,
    firehose: params.firehose,
    ...(params.webhooks === undefined ? {} : { webhooks: params.webhooks }),
    ...(params.plugins === undefined ? {} : { plugins: params.plugins }),
  });

  if (params.methods !== undefined && params.methods.length > 0) {
    registerPluginMethods(
      server,
      {
        config: params.config,
        accounts: params.accounts,
        repo: params.repo,
        replay: params.replay,
        firehose: params.firehose,
      },
      params.methods,
    );
  }

  registerAccountMethods(server, {
    config: params.config,
    accounts: params.accounts,
    repo: params.repo,
    replay: params.replay,
    mail: params.mail,
    // A status move is a public event (`lfmr`): the same firehose every other surface writes to.
    firehose: params.firehose,
    ...(params.handleDns === undefined ? {} : { handleDns: params.handleDns }),
  });

  registerAdminMethods(server, {
    config: params.config,
    accounts: params.accounts,
    replay: params.replay,
    repo: params.repo,
    firehose: params.firehose,
  });

  registerBlobMethods(server, {
    config: params.config,
    accounts: params.accounts,
    blobs: params.blobs,
    repo: params.repo,
    replay: params.replay,
  });

  registerPrefsMethods(server, {
    config: params.config,
    accounts: params.accounts,
    replay: params.replay,
  });

  registerIdentityMethods(server, {
    config: params.config,
    accounts: params.accounts,
    replay: params.replay,
    ...(params.handleDns === undefined ? {} : { handleDns: params.handleDns }),
    ...(params.handles === undefined ? {} : { handles: params.handles }),
  });

  registerSyncMethods(server, {
    config: params.config,
    accounts: params.accounts,
    repo: params.repo,
    replay: params.replay,
  });

  registerSpaceMethods(server, {
    config: params.config,
    accounts: params.accounts,
    blobs: params.blobs,
    spaces: params.spaces,
    replay: params.replay,
    writes: params.spaceWrites ?? defaultSpaceWritesFor(params.spaces),
    ...(params.appKeys === undefined ? {} : { appKeys: params.appKeys }),
    // The space's own stream: a space's writes are not public, so they are not on the firehose.
    firehose: params.firehose,
    ...(params.identity === undefined ? {} : { identity: params.identity }),
    ...(params.spaceHooks === undefined
      ? {}
      : { spaceHooks: params.spaceHooks }),
  });

  return server;
};

/**
 * The write log a server gets when it names none: the same `Kv` its space archives live in, so a space
 * repo survives a restart.
 *
 * It is cached per `SpaceStore` because a Worker builds the surface per request and the log is a
 * service, not a row: one store, one log. The fence is `makeWriteLock()` — an epoch inside this
 * process. Two hosts sharing one store are still protected by the head row's CAS; what a process-local
 * epoch does not catch is a host that was superseded by *another host* and has not restarted. A
 * deployment with a `ShardLease` passes `spaceWrites` built from `writeLockOverLease` and gets that
 * too (`wks8`).
 */
const defaultSpaceWrites = new WeakMap<object, SpaceWrites>();
const defaultSpaceWritesFor = (spaces: SpaceStore['Service']) => {
  const held = defaultSpaceWrites.get(spaces);
  if (held !== undefined) {
    return held;
  }
  const lock = makeWriteLock();
  const made = {
    lock,
    log: spaceWriteLogOverKv({ kv: spaces.kv, lock }),
  };
  defaultSpaceWrites.set(spaces, made);
  return made;
};

/** The store could not answer, which is ours to be sorry for. */
const storeUnavailable = (message: string) =>
  new XrpcError({ error: 'InternalServerError', message, status: 500 });
