import { Effect, Option, Schema } from 'effect';
import {
  type PdsConfig,
  authenticate,
  forbidden,
  invalid,
  serverError,
} from './pds.js';
import { RepoStore, writePut, writeRemove } from '@eoa/repo-store';
import { ACCESS_SCOPE } from './token.js';
import { type AccountStore } from './account-store.js';
import { type DpopReplay } from './dpop-replay.js';
import { type Firehose } from './firehose.js';
import { type XrpcServer } from '@eoa/xrpc-server';
import { commitWrites } from './repo.js';

/**
 * The moderation surface (the Effect-PDS map, `84r6`).
 *
 * Moderation is a **check**, not a service. The account machine already has the
 * moves — `suspend` from active, `reinstate` from suspended, which are the
 * spec's rules — and what was missing is *who may make them*. An operator names
 * the DIDs, because the authority belongs to the org and the org is not a thing
 * this package can see; the AaaS layer is where it becomes one.
 */

/** What the surface needs: the store, who we are, and who may act. */
export interface AdminSurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly replay: DpopReplay['Service'];
  readonly repo: RepoStore['Service'];
  readonly firehose: Firehose['Service'];
}

/** The DIDs an operator named as moderators. Nobody by default. */
export const isModerator = (config: PdsConfig, did: string) =>
  (config.adminDids ?? []).includes(did);

const ModerateRecordSchema = Schema.Struct({
  uri: Schema.String,
  action: Schema.Union([Schema.Literal('takedown'), Schema.Literal('reverse')]),
});

/** `at://{did}/{collection}/{rkey}` — the record a moderation names. */
const keyIn = (uri: string) => {
  const parts = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(uri);
  if (parts === null) {
    return Option.none<{ did: string; key: string }>();
  }
  return Option.some({
    did: parts[1] ?? '',
    key: `${parts[2] ?? ''}/${parts[3] ?? ''}`,
  });
};

const ModerateAccountSchema = Schema.Struct({
  account: Schema.String,
  action: Schema.Union([
    Schema.Literal('takedown'),
    Schema.Literal('reinstate'),
  ]),
});

/**
 * A record, taken down or put back.
 *
 * **A takedown removes the record through the ordinary write path**, rather than
 * hiding it behind a marker. That is what makes it real: the commit is signed,
 * the stream shows it, and a reader that has the CID finds nothing — which is the
 * correct outcome, and the only one a CAR can express. What was removed is kept
 * first, in the repo's own `T/` rows, so a reversal restores the *bytes* — and so
 * the record's CID comes back with them.
 */
export const registerAdminMethods = (
  server: XrpcServer,
  deps: AdminSurfaceDeps,
) => {
  server.method('com.atproto.admin.moderateAccount', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      if (!isModerator(deps.config, caller.account.did)) {
        return yield* Effect.fail(
          forbidden('this account does not moderate this PDS'),
        );
      }
      const decoded = Schema.decodeUnknownOption(ModerateAccountSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for moderateAccount'));
      }
      const { account, action } = decoded.value;

      // The two actions atproto names, as the spec's two moves. Either is a
      // no-op on a state it does not apply to, which is what the spec says.
      const move =
        action === 'takedown' ? deps.accounts.suspend : deps.accounts.reinstate;
      const moved = yield* move(account).pipe(
        Effect.mapError(() => serverError('the account could not be moved')),
      );
      if (Option.isNone(moved)) {
        return yield* Effect.fail(invalid(`no account ${account}`));
      }
      return {};
    }),
  );

  const DeleteAccountSchema = Schema.Struct({ did: Schema.String });

  /**
   * An operator deleting an account for good.
   *
   * `com.atproto.server.deleteAccount` is the **account holder's** verb and wants a token emailed to
   * them; an org must not be stuck waiting on an email to remove an account it runs. So the
   * operator's route is the admin one, which is the name atproto already uses for this: the account
   * is removed (the spec's own delete — sessions dropped with it, the handle released), and its
   * repo goes too.
   *
   * // ponytail: the account's blobs are left in the bucket. They are rows keyed by DID and dropping
   * // them is a sweep, not something to bolt onto a moderation call; the ceiling is storage that
   * // outlives the account.
   */
  server.method('com.atproto.admin.deleteAccount', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      if (!isModerator(deps.config, caller.account.did)) {
        return yield* Effect.fail(
          forbidden('this account does not moderate this PDS'),
        );
      }
      const decoded = Schema.decodeUnknownOption(DeleteAccountSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for deleteAccount'));
      }
      const { did } = decoded.value;

      // The repo first, the account last: the last step is the one that makes it disappear, and a
      // repo left behind by a failure is easier to see than an account left behind by one.
      yield* deps.repo
        .deleteRepo(did)
        .pipe(
          Effect.mapError(() => serverError('the repo could not be deleted')),
        );
      const removed = yield* deps.accounts
        .remove(did)
        .pipe(
          Effect.mapError(() =>
            serverError('the account could not be deleted'),
          ),
        );
      if (Option.isNone(removed)) {
        return yield* Effect.fail(invalid(`no account ${did}`));
      }
      return {};
    }),
  );

  server.method('com.atproto.admin.moderateRecord', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      if (!isModerator(deps.config, caller.account.did)) {
        return yield* Effect.fail(
          forbidden('this account does not moderate this PDS'),
        );
      }
      const decoded = Schema.decodeUnknownOption(ModerateRecordSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for moderateRecord'));
      }
      const named = keyIn(decoded.value.uri);
      if (Option.isNone(named)) {
        return yield* Effect.fail(
          invalid(`that is not a record uri: ${decoded.value.uri}`),
        );
      }
      const { did, key } = named.value;
      const now = Date.now();

      if (decoded.value.action === 'takedown') {
        const held = yield* deps.repo
          .record(did, key)
          .pipe(
            Effect.mapError(() => serverError('the record could not be read')),
          );
        if (Option.isNone(held)) {
          return yield* Effect.fail(invalid(`no record ${key} for ${did}`));
        }
        // Kept first: a takedown that loses the record cannot be reversed.
        yield* deps.repo
          .takeDown(did, key, held.value)
          .pipe(
            Effect.mapError(() =>
              serverError('the takedown could not be kept'),
            ),
          );
        const done = yield* commitWrites(
          deps,
          did,
          [writeRemove({ key })],
          undefined,
          now,
        );
        return { commit: { cid: done.commit, rev: done.rev } };
      }

      const kept = yield* deps.repo
        .takenDown(did, key)
        .pipe(
          Effect.mapError(() => serverError('the takedown could not be read')),
        );
      if (Option.isNone(kept)) {
        return yield* Effect.fail(invalid(`no takedown of ${key} for ${did}`));
      }
      // Back as it was: the bytes are the record's identity, so the CID returns.
      const done = yield* commitWrites(
        deps,
        did,
        [writePut({ key, bytes: kept.value })],
        undefined,
        now,
      );
      yield* deps.repo
        .deleteTakedown(did, key)
        .pipe(
          Effect.mapError(() =>
            serverError('the takedown could not be cleared'),
          ),
        );
      return { commit: { cid: done.commit, rev: done.rev } };
    }),
  );
};
