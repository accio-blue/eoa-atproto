import { CODEC_DAG_CBOR, cidFromDigest, parseCid } from '@eoa/core';
import { Effect, Option, Result, Schema } from 'effect';
import {
  type PdsConfig,
  authenticateAccess,
  invalid,
  notFound,
  readableDid,
  serverError,
} from './pds.js';
import { type RepoStore, encodeCar } from '@eoa/repo-store';
import { type AccountStore } from './account-store.js';
import { type DpopReplay } from './dpop-replay.js';
import { type XrpcServer } from '@eoa/xrpc-server';
import { sha256 } from '@eoa/crypto';

/**
 * Sync, at the surface (the Effect-PDS map, `msbm`).
 *
 * The **backfill** half of the firehose: the stream carries what changed, and
 * these carry the whole repo. A relay that has been away ingests one CAR and is
 * caught up, which is why the stream itself keeps no archive — an old cursor is
 * refused by name rather than served from a history nobody kept.
 *
 * `getRepoStatus` and `listBlobs` are elsewhere: the first is the server's own
 * (it is about the account as much as the repo), and the second belongs with the
 * blobs it lists.
 */

const ListReposSchema = Schema.Struct({
  // Query parameters arrive as strings, the same way `repo.listRecords` reads its limit.
  limit: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
});

const GetRepoSchema = Schema.Struct({
  did: Schema.String,
  /** A CAR from this revision on — the whole repo is served either way. */
  since: Schema.optional(Schema.String),
});

/** What the sync surface needs: the repo model, who we are, and who is asking. */
export interface SyncSurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly repo: RepoStore['Service'];
  readonly replay: DpopReplay['Service'];
}

export const registerSyncMethods = (
  server: XrpcServer,
  deps: SyncSurfaceDeps,
) => {
  server.method('com.atproto.sync.getLatestCommit', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(GetRepoSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getLatestCommit'));
      }
      const did = yield* readableDid(deps, decoded.value.did);
      const head = yield* deps.repo
        .head(did)
        .pipe(Effect.mapError(() => serverError('the repo could not be read')));
      return Option.isNone(head)
        ? yield* Effect.fail(notFound('RepoNotFound', did))
        : { cid: head.value.root, rev: head.value.rev };
    }),
  );

  /**
   * Who lives here, and where their repo is (`b49d` needs it: a backup sweep with a list of DIDs typed
   * in by hand is a backup that silently misses the next account).
   *
   * A cursor is the last DID served, and the order is the DIDs' own — the same pagination shape as
   * every other list on this surface. Accounts without a repo, and deleted ones, are not listed:
   * there is nothing to fetch for them.
   */
  server.method('com.atproto.sync.listRepos', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(ListReposSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listRepos'));
      }
      const asked = Number(decoded.value.limit ?? '100');
      const limit = Math.min(
        Math.max(Number.isFinite(asked) ? asked : 100, 1),
        1000,
      );
      const cursor = decoded.value.cursor;

      const accounts = yield* deps.accounts.list.pipe(
        Effect.mapError(() => serverError('the accounts could not be read')),
      );
      const live = accounts
        .filter((one) => one.status !== 'deleted')
        .map((one) => one.did)
        .sort();
      const from =
        cursor === undefined ? live : live.filter((did) => did > cursor);
      const page = from.slice(0, limit);

      const repos = yield* Effect.forEach(page, (did) =>
        deps.repo.head(did).pipe(
          Effect.mapError(() => serverError('the repo could not be read')),
          Effect.map((head) =>
            Option.isNone(head)
              ? undefined
              : { did, head: head.value.root, rev: head.value.rev },
          ),
        ),
      );

      return {
        repos: repos.filter((one) => one !== undefined),
        ...(from.length > limit ? { cursor: page.at(-1) } : {}),
      };
    }),
  );

  server.method('com.atproto.sync.getRepo', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(GetRepoSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getRepo'));
      }
      // A CAR carries every collection at once, so one private collection closes this read: there is
      // no way to serve a repo without serving what the deployment keeps behind a session.
      if ((deps.config.privateCollections ?? []).length > 0) {
        yield* authenticateAccess(deps, ctx);
      }
      const did = yield* readableDid(deps, decoded.value.did);
      const loaded = yield* deps.repo
        .load(did)
        .pipe(Effect.mapError(() => serverError('the repo could not be read')));
      if (Option.isNone(loaded.head)) {
        return yield* Effect.fail(notFound('RepoNotFound', did));
      }
      const records = yield* deps.repo
        .leaves(did, '', '\uffff')
        .pipe(
          Effect.mapError(() => serverError('the records could not be read')),
        );
      const commit = yield* deps.repo
        .commit(did, loaded.head.value.root)
        .pipe(
          Effect.mapError(() => serverError('the commit could not be read')),
        );
      const root = parseCid(loaded.head.value.root);
      if (Option.isNone(commit) || Result.isFailure(root)) {
        return yield* Effect.fail(notFound('RepoNotFound', did));
      }

      // Every block a reader needs to walk the repo: the commit, its tree, and
      // every record — each addressed by the CID of its own bytes.
      const recordBlocks = yield* Effect.forEach(records, (record) =>
        Effect.gen(function* () {
          const digest = yield* sha256(record.value);
          return {
            cid: cidFromDigest({ codec: CODEC_DAG_CBOR, digest }),
            bytes: record.value,
          };
        }).pipe(
          Effect.mapError(() => serverError('a record could not be hashed')),
        ),
      );
      const nodes = yield* Effect.forEach(loaded.nodes, (node) => {
        const cid = parseCid(node.cid);
        return Result.isFailure(cid)
          ? Effect.fail(serverError('a node CID does not parse'))
          : Effect.succeed({ cid: cid.success, bytes: node.bytes });
      });

      const car = encodeCar({
        roots: [root.success],
        blocks: [
          { cid: root.success, bytes: commit.value },
          ...nodes,
          ...recordBlocks,
        ],
      });
      // A CAR is bytes, so it answers as bytes — the transport carries a
      // Response as it stands.
      return new Response(Uint8Array.from(car), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.ipld.car' },
      });
    }),
  );
};
