import { Effect, Option, Schema } from 'effect';
import { authenticate, invalid, serverError } from './pds.js';
import { ACCESS_SCOPE } from './token.js';
import { type AccountStore } from './account-store.js';
import type { DpopReplay } from './dpop-replay.js';
import { type PdsConfig } from './pds.js';
import type { XrpcServer } from '@eoa/xrpc-server';

/**
 * Private state: `app.bsky.actor.getPreferences` / `putPreferences` (`t2cg`).
 *
 * Preferences are **not records**. They do not ride the CAR, so a move has to carry them explicitly
 * or they are lost silently — which is what PDS MOOver does, and what a client that assumes "the repo
 * is the account" gets wrong.
 *
 * What this surface owes is small on purpose: one opaque row per account, written and read back as it
 * was given. The *shape* of a preference is the app's (bluesky's own union grows, and a different app
 * keeps different things in there), so nothing here decodes a preference's meaning — only that it is
 * JSON, which is the one thing a client's own lexicon promises.
 */

/** The preferences a client keeps: an array of opaque JSON values. */
const PreferencesSchema = Schema.Struct({
  preferences: Schema.Array(Schema.Json),
});

/**
 * How much private state an account may keep.
 *
 * A Durable Object caps a value at 128 KiB, and this row shares that budget with everything else the
 * account owns — so it refuses at half, where a client can read the refusal, rather than at the
 * storage's own ceiling where a write fails with nothing to act on.
 */
const MAX_PREFS_BYTES = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the preferences surface needs: the account's rows, and who is asking. */
export interface PrefsSurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly replay: DpopReplay['Service'];
}

export const registerPrefsMethods = (
  server: XrpcServer,
  deps: PrefsSurfaceDeps,
) => {
  server.method('app.bsky.actor.getPreferences', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const held = yield* deps.accounts
        .prefs(caller.account.did)
        .pipe(
          Effect.mapError(() =>
            serverError('the preferences could not be read'),
          ),
        );
      // A fresh account has written nothing, and an empty list is what a client expects of one.
      if (Option.isNone(held)) {
        return { preferences: [] };
      }
      const decoded = Schema.decodeUnknownOption(
        Schema.fromJsonString(PreferencesSchema),
      )(decoder.decode(held.value));
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          serverError('the stored preferences do not parse'),
        );
      }
      return decoded.value;
    }),
  );

  server.method('app.bsky.actor.putPreferences', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(PreferencesSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for putPreferences'));
      }
      // Encoded once, so what is stored is what was measured — and so a client that reads it back
      // gets the same bytes the mover will carry.
      const bytes = encoder.encode(
        Schema.encodeSync(Schema.fromJsonString(PreferencesSchema))(
          decoded.value,
        ),
      );
      if (bytes.length > MAX_PREFS_BYTES) {
        return yield* Effect.fail(
          invalid(`private state is capped at ${MAX_PREFS_BYTES} bytes`),
        );
      }
      yield* deps.accounts
        .putPrefs(caller.account.did, bytes)
        .pipe(
          Effect.mapError(() =>
            serverError('the preferences could not be written'),
          ),
        );
      return {};
    }),
  );
};
