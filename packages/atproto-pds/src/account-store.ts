import { Context, Data, Effect, Layer, Metric, Option, Schema } from 'effect';
import type { Entry, KvError, Sequence, Value } from '@eoa/kv';
import {
  Kv,
  absentCondition,
  deleteOp,
  putOp,
  versionCondition,
} from '@eoa/kv';
import {
  accountsCreated,
  refused,
  sessionsCreated,
  sessionsRevoked,
} from './metrics.js';
import type { CryptoError } from '@eoa/crypto';

/**
 * Accounts on the KV (the Effect-PDS map, `wrds`).
 *
 * The rules are `account-lifecycle.qnt`'s, not ours: the spec's machine is
 * `status` over `{absent, created, active, suspended, deleted}` plus
 * `handleReserved`, and its five actions are the five transitions here —
 *
 * - `create` only from `absent`, and only when the handle is free; a taken
 *   handle leaves the account absent;
 * - `activate` from `created`, `suspend` from `active`, `reinstate` from
 *   `suspended` — each leaving any other state untouched;
 * - `deleteAccount` from `active` or `suspended`, **releasing the handle**;
 * - and `deleted` is terminal, because creation requires the absent state and a
 *   deleted account keeps its row.
 *
 * The handle's reservation *is* its row: `H/{handle}` exists exactly while some
 * account holds it, which is the spec's `handleReserved` read the other way
 * round. So a handle is claimed by the same atomic batch that creates the
 * account — the refusal the spec describes is a `KeyPreconditionFailed`, and a
 * lost race is the same refusal, not a different one.
 *
 * A **session** is not in the spec, and deliberately so: whether a session may
 * speak is a predicate over the account's status (`active`, and nothing else),
 * not a state of its own. The row is the revocation list; the token only says
 * which row.
 */

/** How many rows a single scan will read; a streaming iterator is the next step. */
const SCAN_LIMIT = 10_000;

const accountKey = (did: string) => `A/${did}`;

/** A handle, while someone holds it — the spec's `handleReserved`, as a row. */
const handleKey = (handle: string) => `H/${handle}`;

const sessionsUnder = (did: string) => `S/${did}/`;

const sessionKey = (did: string, id: string) => `${sessionsUnder(did)}${id}`;

const appPasswordsUnder = (did: string) => `P/${did}/`;

const appPasswordKey = (did: string, name: string) =>
  `${appPasswordsUnder(did)}${name}`;

const inviteKey = (code: string) => `I/${code}`;

const tokenKey = (did: string, purpose: string) => `X/${did}/${purpose}`;

/**
 * The account's private state: what does not ride a CAR and what a client would lose silently if a
 * move forgot it (`t2cg`). One row, opaque here — its shape is the app's business.
 */
const prefsKey = (did: string) => `PR/${did}`;

/**
 * The account's `#atproto_kem` keypair, beside the row that says who the account
 * is (spaces alpha, 2026-10-22, section 7).
 *
 * It never signs anything, so nothing here is a key a request authenticates
 * with: a syncer encapsulates against the *public* half to agree a commit's
 * shared secret, and only this host can decapsulate. The secret is stored in the
 * clear because the store is the trust boundary the signing key already sits
 * behind — there is nothing else to protect it with.
 */
const kemKeyOf = (did: string) => `K/${did}`;

/**
 * Whether the one-shot KEM backfill has run to completion. Its own prefix
 * (`KB/`, not `K/`) so an account scan never reads it as a key.
 */
const KEM_BACKFILL_KEY = 'KB/complete';

/** A row that is there but unreadable. */
export class CorruptAccount extends Schema.TaggedError<CorruptAccount>()(
  'CorruptAccount',
  { key: Schema.String },
) {}

export type AccountStatus = 'created' | 'active' | 'suspended' | 'deleted';

export interface Account {
  readonly did: string;
  readonly handle: string;
  readonly status: AccountStatus;
  readonly email: string | null;
  readonly passwordHash: string;
  readonly createdAt: number;
}

export interface Session {
  readonly id: string;
  readonly did: string;
  /** The app password this session was opened with, when it was one. */
  readonly appPasswordName: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AppPassword {
  readonly name: string;
  /** `sha256(secret)`, base64url — a digest is enough for a random secret. */
  readonly digest: string;
  readonly privileged: boolean;
  readonly createdAt: number;
}

/**
 * A one-use token, waiting for the account that asked for one: one use, and it
 * expires. The digest is kept, not the token, for the same reason an app
 * password's is — a store that leaks should not hand over the secrets. The
 * *purpose* is in the key, so a deletion and a verification cannot be spent for
 * each other.
 */
export interface OneUseToken {
  readonly digest: string;
  readonly expiresAt: number;
}

/**
 * One invite: the ticket an outsider redeems to become an account here (`gh0f`).
 *
 * The code is the whole capability — it is shown once, and a store that leaks
 * hands over doors — so the row says only what a decision needs: who it admits
 * (`forAccount`), how many times (`usesAvailable`, spent in the same batch as
 * the account), until when (`expiresAt`), and whether it still stands
 * (`disabled`).
 *
 * Revoking one is `putInvite({ ...one, disabled: true })`: the row is keyed by
 * code, so one ticket moves and the others do not. Revoking a *ticket* is not
 * removing the *member* it admitted — an account that exists is a different
 * question, with a different answer.
 */
export interface Invite {
  readonly code: string;
  readonly forAccount: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  /** When the code stops being usable, in ms. Absent means it does not expire. */
  readonly expiresAt?: number;
  readonly usesAvailable: number;
  readonly disabled: boolean;
}

/**
 * An account's stored `#atproto_kem` keypair.
 *
 * Both halves are strings because the store's job is to keep rows, not to do
 * crypto: `secret` is the base64url scalar, `didKey` the public half in the
 * encoding a DID document carries.
 */
export interface StoredKemKey {
  readonly secret: string;
  readonly didKey: string;
  readonly createdAt: number;
}

const AccountStatusSchema = Schema.Union([
  Schema.Literal('created'),
  Schema.Literal('active'),
  Schema.Literal('suspended'),
  Schema.Literal('deleted'),
]);

const AccountSchema = Schema.Struct({
  did: Schema.String,
  handle: Schema.String,
  status: AccountStatusSchema,
  email: Schema.Union([Schema.String, Schema.Null]),
  passwordHash: Schema.String,
  createdAt: Schema.Number,
});

const SessionSchema = Schema.Struct({
  id: Schema.String,
  did: Schema.String,
  appPasswordName: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});

const AppPasswordSchema = Schema.Struct({
  name: Schema.String,
  digest: Schema.String,
  privileged: Schema.Boolean,
  createdAt: Schema.Number,
});

const OneUseTokenSchema = Schema.Struct({
  digest: Schema.String,
  expiresAt: Schema.Number,
});

const InviteSchema = Schema.Struct({
  code: Schema.String,
  forAccount: Schema.Union([Schema.String, Schema.Null]),
  createdBy: Schema.String,
  createdAt: Schema.Number,
  // Absent on rows written before invites expired: an unexpiring ticket is the
  // reading that keeps them working, and the only one that does not expire them
  // retroactively.
  expiresAt: Schema.optionalKey(Schema.Number),
  usesAvailable: Schema.Number,
  disabled: Schema.Boolean,
});

const KemKeySchema = Schema.Struct({
  /** The 32-byte secret scalar, base64url: the half that never leaves. */
  secret: Schema.String,
  /** The public half as a P-256 `did:key` — what the DID document publishes. */
  didKey: Schema.String,
  createdAt: Schema.Number,
});

const decodeAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(AccountSchema),
);
const encodeAccount = Schema.encodeSync(Schema.fromJsonString(AccountSchema));

const decodeSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionSchema),
);
const encodeSession = Schema.encodeSync(Schema.fromJsonString(SessionSchema));

const decodeAppPassword = Schema.decodeUnknownOption(
  Schema.fromJsonString(AppPasswordSchema),
);
const encodeAppPassword = Schema.encodeSync(
  Schema.fromJsonString(AppPasswordSchema),
);

const decodeInvite = Schema.decodeUnknownOption(
  Schema.fromJsonString(InviteSchema),
);
const encodeInvite = Schema.encodeSync(Schema.fromJsonString(InviteSchema));

const decodeOneUseToken = Schema.decodeUnknownOption(
  Schema.fromJsonString(OneUseTokenSchema),
);
const encodeOneUseToken = Schema.encodeSync(
  Schema.fromJsonString(OneUseTokenSchema),
);

const decodeKemKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(KemKeySchema),
);
const encodeKemKey = Schema.encodeSync(Schema.fromJsonString(KemKeySchema));

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const utf8 = (value: string) => encoder.encode(value);

const text = (value: Value) => decoder.decode(value);

export interface CreateParams {
  readonly did: string;
  readonly handle: string;
  readonly email: string | null;
  readonly passwordHash: string;
  readonly inviteCode: string | undefined;
  readonly inviteRequired: boolean;
  readonly now: number;
}

/** What `create` did — a refusal is an outcome, not an error. */
export type CreateOutcomeMap = Data.TaggedEnum<{
  readonly created: { readonly account: Account };
  readonly handleTaken: { readonly handle: string };
  readonly alreadyExists: { readonly did: string };
  readonly inviteRequired: {};
  readonly inviteInvalid: { readonly code: string };
}>;

export const {
  created: createSucceeded,
  handleTaken: createHandleTaken,
  alreadyExists: createAlreadyExists,
  inviteRequired: createNeedsInvite,
  inviteInvalid: createInviteInvalid,
  $match: matchCreateOutcome,
} = Data.taggedEnum<CreateOutcomeMap>();

/**
 * Count a registration by how it ended (ticket `i1vo`). One tap at the end of
 * `create` covers every refusal — the three decided early and the lost race
 * alike — because they all arrive as an outcome.
 */
const countCreateOutcome = (outcome: CreateOutcomeMap) =>
  matchCreateOutcome(outcome, {
    created: () => Metric.update(accountsCreated, 1),
    handleTaken: () => refused('handle_taken'),
    alreadyExists: () => refused('already_exists'),
    inviteRequired: () => refused('invite_required'),
    inviteInvalid: () => refused('invite_invalid'),
  });

export type AccountError = CorruptAccount | CryptoError | KvError;

/** What a handle change did — a refusal is an outcome, not an error. */
export type RehandleOutcomeMap = Data.TaggedEnum<{
  readonly moved: { readonly account: Account };
  readonly unchanged: { readonly account: Account };
  readonly handleTaken: { readonly handle: string };
  readonly noAccount: { readonly did: string };
  /** Someone changed the account first; the caller re-reads and tries again. */
  readonly raced: { readonly did: string };
}>;

export const {
  moved: rehandleMoved,
  unchanged: rehandleUnchanged,
  handleTaken: rehandleHandleTaken,
  noAccount: rehandleNoAccount,
  raced: rehandleRaced,
} = Data.taggedEnum<RehandleOutcomeMap>();

export class AccountStore extends Context.Service<
  AccountStore,
  {
    readonly account: (
      did: string,
    ) => Effect.Effect<Option.Option<Account>, AccountError>;
    readonly byHandle: (
      handle: string,
    ) => Effect.Effect<Option.Option<Account>, AccountError>;
    /** Every account this PDS has, for an operator asking. */
    readonly list: Effect.Effect<ReadonlyArray<Account>, AccountError>;
    readonly create: (
      params: CreateParams,
    ) => Effect.Effect<CreateOutcomeMap, AccountError>;
    /** The spec's `activate` / `suspend` / `reinstate`, as three moves. */
    readonly activate: (
      did: string,
    ) => Effect.Effect<Option.Option<Account>, AccountError>;
    readonly suspend: (
      did: string,
    ) => Effect.Effect<Option.Option<Account>, AccountError>;
    readonly reinstate: (
      did: string,
    ) => Effect.Effect<Option.Option<Account>, AccountError>;
    /** The email was confirmed, and when. Its own row: no account to migrate. */
    readonly markVerified: (
      did: string,
      at: number,
    ) => Effect.Effect<Sequence, AccountError>;
    readonly verifiedAt: (
      did: string,
    ) => Effect.Effect<Option.Option<number>, AccountError>;
    /** The spec's `deleteAccount`: from a live state, releasing the handle. */
    readonly remove: (
      did: string,
    ) => Effect.Effect<Option.Option<Account>, AccountError>;
    /**
     * The spec's `handleReserved`, moved: claim the new handle and release the
     * old one in the same batch, so a handle is never held twice and never
     * dropped without a claim.
     */
    readonly rehandle: (
      did: string,
      handle: string,
    ) => Effect.Effect<RehandleOutcomeMap, AccountError>;
    /**
     * A new password hash for the account: the row's one field a person changes
     * on purpose (`com.atproto.server.updatePassword`). The caller has already
     * hashed it; this store keeps secrets, it does not make them.
     */
    readonly setPassword: (
      did: string,
      passwordHash: string,
    ) => Effect.Effect<Option.Option<Account>, AccountError>;
    readonly sessions: (
      did: string,
    ) => Effect.Effect<ReadonlyArray<Session>, AccountError>;
    readonly session: (
      did: string,
      id: string,
    ) => Effect.Effect<Option.Option<Session>, AccountError>;
    readonly putSession: (
      session: Session,
    ) => Effect.Effect<Sequence, AccountError>;
    readonly deleteSession: (
      did: string,
      id: string,
    ) => Effect.Effect<Sequence, AccountError>;
    /**
     * The account's private state, as it was last written — nothing when it has written none.
     */
    readonly prefs: (
      did: string,
    ) => Effect.Effect<Option.Option<Value>, AccountError>;
    readonly putPrefs: (
      did: string,
      prefs: Value,
    ) => Effect.Effect<Sequence, AccountError>;
    readonly appPasswords: (
      did: string,
    ) => Effect.Effect<ReadonlyArray<AppPassword>, AccountError>;
    readonly putAppPassword: (
      did: string,
      password: AppPassword,
    ) => Effect.Effect<Sequence, AccountError>;
    readonly deleteAppPassword: (
      did: string,
      name: string,
    ) => Effect.Effect<Sequence, AccountError>;
    readonly invite: (
      code: string,
    ) => Effect.Effect<Option.Option<Invite>, AccountError>;
    readonly putInvite: (
      invite: Invite,
    ) => Effect.Effect<Sequence, AccountError>;
    readonly invitesOf: (
      did: string,
    ) => Effect.Effect<ReadonlyArray<Invite>, AccountError>;
    /** A one-use token's digest, waiting for the account that asked for one. */
    readonly putToken: (
      did: string,
      purpose: string,
      token: OneUseToken,
    ) => Effect.Effect<Sequence, AccountError>;
    /**
     * The account's `#atproto_kem` keypair, when it has one.
     *
     * Kept beside the account row rather than in config because it is
     * per-account, and because it is the same sort of secret the password hash
     * is: something this host holds on the account's behalf.
     */
    readonly kemKey: (
      did: string,
    ) => Effect.Effect<Option.Option<StoredKemKey>, AccountError>;
    /**
     * Store a keypair only if the account has none. A losing write is a
     * `KeyPreconditionFailed`, so two hosts racing generate one key, not two.
     */
    readonly putKemKey: (
      did: string,
      key: StoredKemKey,
    ) => Effect.Effect<Sequence, AccountError>;
    /** Whether the one-shot backfill has completed; a failed run leaves it unset. */
    readonly kemBackfillComplete: Effect.Effect<boolean, AccountError>;
    readonly markKemBackfillComplete: (
      at: number,
    ) => Effect.Effect<Sequence, AccountError>;
    /** The token waiting for an account and a purpose, if one is. */
    readonly token: (
      did: string,
      purpose: string,
    ) => Effect.Effect<Option.Option<OneUseToken>, AccountError>;
    /** Spend it: a token is good for one use. */
    readonly deleteToken: (
      did: string,
      purpose: string,
    ) => Effect.Effect<void, AccountError>;
  }
>()('@eoa/atproto-pds/AccountStore') {}

export const accountStoreLayer = Layer.effect(
  AccountStore,
  Effect.gen(function* () {
    const kv = yield* Kv;

    const readAccount = (did: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(accountKey(did));
        if (Option.isNone(found)) {
          return Option.none<Account>();
        }
        const decoded = decodeAccount(text(found.value.value));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(
            new CorruptAccount({ key: accountKey(did) }),
          );
        }
        return Option.some(decoded.value);
      });

    const account = readAccount;

    const byHandle = (handle: string) =>
      Effect.gen(function* () {
        const held = yield* kv.get(handleKey(handle));
        return Option.isNone(held)
          ? Option.none<Account>()
          : yield* readAccount(text(held.value.value));
      });

    /** Every account, by one scan of the account rows. */
    const list = Effect.gen(function* () {
      const page = yield* kv.scan({ prefix: 'A/', limit: SCAN_LIMIT });
      return yield* Effect.forEach(page.entries, (entry) => {
        const decoded = decodeAccount(text(entry.value));
        return Option.isNone(decoded)
          ? Effect.fail(new CorruptAccount({ key: entry.key }))
          : Effect.succeed(decoded.value);
      });
    });

    const create = (params: CreateParams) =>
      Effect.gen(function* () {
        // create: registration requires the absent state — and a deleted
        // account is terminal, because its row is still there to say so.
        const existing = yield* kv.get(accountKey(params.did));
        if (Option.isSome(existing)) {
          return createAlreadyExists({ did: params.did });
        }

        // ...and a free handle.
        const held = yield* kv.get(handleKey(params.handle));
        if (Option.isSome(held)) {
          return createHandleTaken({ handle: params.handle });
        }

        // An invite, when one is required or offered. Its use is spent in the
        // same batch as the account, so a code is never spent twice, and never
        // spent on nothing.
        const code = params.inviteCode;
        if (params.inviteRequired && code === undefined) {
          return createNeedsInvite();
        }
        const foundInvite =
          code === undefined
            ? Option.none<Entry>()
            : yield* kv.get(inviteKey(code));
        const invite =
          Option.isNone(foundInvite) || code === undefined
            ? Option.none<Invite>()
            : decodeInvite(text(foundInvite.value.value));
        if (code !== undefined) {
          if (Option.isNone(invite)) {
            return createInviteInvalid({ code });
          }
          const one = invite.value;
          const spent =
            one.disabled ||
            one.usesAvailable <= 0 ||
            // Judged at the moment of the decision, not at mint: a ticket that
            // was good when handed out is still not good now.
            (one.expiresAt !== undefined && one.expiresAt <= params.now) ||
            (one.forAccount !== null && one.forAccount !== params.did);
          if (spent) {
            return createInviteInvalid({ code });
          }
        }

        const account: Account = {
          did: params.did,
          handle: params.handle,
          status: 'created',
          email: params.email,
          passwordHash: params.passwordHash,
          createdAt: params.now,
        };

        const inviteOps =
          Option.isNone(invite) || Option.isNone(foundInvite)
            ? []
            : [
                putOp({
                  key: inviteKey(invite.value.code),
                  value: utf8(
                    encodeInvite({
                      ...invite.value,
                      usesAvailable: invite.value.usesAvailable - 1,
                    }),
                  ),
                  condition: versionCondition({
                    version: foundInvite.value.version,
                  }),
                }),
              ];

        yield* kv.batch(
          [
            putOp({
              key: accountKey(params.did),
              value: utf8(encodeAccount(account)),
              condition: absentCondition(),
            }),
            putOp({
              key: handleKey(params.handle),
              value: utf8(params.did),
              condition: absentCondition(),
            }),
          ].concat(inviteOps),
        );

        return createSucceeded({ account });
      }).pipe(
        // A batch refused its precondition is the refusal the spec describes:
        // someone else took the handle (or the DID) first, and nothing moved.
        Effect.catchTag('KeyPreconditionFailed', (refused) =>
          Effect.succeed(
            refused.key === accountKey(params.did)
              ? createAlreadyExists({ did: params.did })
              : refused.key === handleKey(params.handle)
                ? createHandleTaken({ handle: params.handle })
                : createInviteInvalid({ code: params.inviteCode ?? '' }),
          ),
        ),
        // The outcome is where the counting happens: every refusal path above
        // (and the lost race here) arrives as one, so a single tap covers them.
        Effect.tap(countCreateOutcome),
      );

    /** A move, or — per the spec — the state staying exactly where it is. */
    const move = (did: string, next: (account: Account) => Account) =>
      Effect.gen(function* () {
        const found = yield* kv.get(accountKey(did));
        if (Option.isNone(found)) {
          return Option.none<Account>();
        }
        const decoded = decodeAccount(text(found.value.value));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(
            new CorruptAccount({ key: accountKey(did) }),
          );
        }
        const before = decoded.value;
        const after = next(before);
        if (after.status !== before.status) {
          yield* kv.put(
            accountKey(did),
            utf8(encodeAccount(after)),
            versionCondition({ version: found.value.version }),
          );
        }
        return Option.some(after);
      });

    const activate = (did: string) =>
      move(did, (one) =>
        one.status === 'created' ? { ...one, status: 'active' } : one,
      );

    const markVerified = (did: string, at: number) =>
      kv.put(`V/${did}`, utf8(String(at)));

    const verifiedAt = (did: string) =>
      kv
        .get(`V/${did}`)
        .pipe(Effect.map(Option.map((found) => Number(text(found.value)))));

    /**
     * Written by hand rather than through `move`: that helper exists for the spec's
     * status transitions and writes only when the status differs, so a password change
     * through it would be a read and no write at all.
     */
    const setPassword = (did: string, passwordHash: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(accountKey(did));
        if (Option.isNone(found)) {
          return Option.none<Account>();
        }
        const decoded = decodeAccount(text(found.value.value));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(
            new CorruptAccount({ key: accountKey(did) }),
          );
        }
        const after = { ...decoded.value, passwordHash };
        yield* kv.put(
          accountKey(did),
          utf8(encodeAccount(after)),
          versionCondition({ version: found.value.version }),
        );
        return Option.some(after);
      });

    const suspend = (did: string) =>
      move(did, (one) =>
        one.status === 'active' ? { ...one, status: 'suspended' } : one,
      );

    const reinstate = (did: string) =>
      move(did, (one) =>
        one.status === 'suspended' ? { ...one, status: 'active' } : one,
      );

    const remove = (did: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(accountKey(did));
        if (Option.isNone(found)) {
          return Option.none<Account>();
        }
        const decoded = decodeAccount(text(found.value.value));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(
            new CorruptAccount({ key: accountKey(did) }),
          );
        }
        const before = decoded.value;
        if (before.status !== 'active' && before.status !== 'suspended') {
          return Option.some(before);
        }
        const deleted: Account = { ...before, status: 'deleted' };
        // The sessions go with the account: a deleted account must not be
        // holding tokens that still resolve to a row.
        const live = yield* kv.scan({
          prefix: sessionsUnder(did),
          limit: SCAN_LIMIT,
        });
        yield* kv.batch(
          [
            putOp({
              key: accountKey(did),
              value: utf8(encodeAccount(deleted)),
              condition: versionCondition({ version: found.value.version }),
            }),
            deleteOp({ key: handleKey(before.handle) }),
          ].concat(live.entries.map((entry) => deleteOp({ key: entry.key }))),
        );
        return Option.some(deleted);
      });

    const rehandle = (did: string, handle: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(accountKey(did));
        if (Option.isNone(found)) {
          return rehandleNoAccount({ did });
        }
        const decoded = decodeAccount(text(found.value.value));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(
            new CorruptAccount({ key: accountKey(did) }),
          );
        }
        const before = decoded.value;
        if (before.handle === handle) {
          return rehandleUnchanged({ account: before });
        }
        const after: Account = { ...before, handle };
        yield* kv.batch([
          putOp({
            key: handleKey(handle),
            value: utf8(did),
            condition: absentCondition(),
          }),
          deleteOp({ key: handleKey(before.handle) }),
          putOp({
            key: accountKey(did),
            value: utf8(encodeAccount(after)),
            condition: versionCondition({ version: found.value.version }),
          }),
        ]);
        return rehandleMoved({ account: after });
      }).pipe(
        // A refused precondition is either the handle being taken or the account
        // having moved under us — and the two want different answers.
        Effect.catchTag('KeyPreconditionFailed', (refused) =>
          Effect.succeed(
            refused.key === handleKey(handle)
              ? rehandleHandleTaken({ handle })
              : rehandleRaced({ did }),
          ),
        ),
      );

    const sessions = (did: string) =>
      Effect.gen(function* () {
        const page = yield* kv.scan({
          prefix: sessionsUnder(did),
          limit: SCAN_LIMIT,
        });
        return yield* Effect.forEach(page.entries, (entry) => {
          const decoded = decodeSession(text(entry.value));
          return Option.isNone(decoded)
            ? Effect.fail(new CorruptAccount({ key: entry.key }))
            : Effect.succeed(decoded.value);
        });
      });

    const session = (did: string, id: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(sessionKey(did, id));
        if (Option.isNone(found)) {
          return Option.none<Session>();
        }
        const decoded = decodeSession(text(found.value.value));
        return Option.isNone(decoded)
          ? yield* Effect.fail(new CorruptAccount({ key: sessionKey(did, id) }))
          : Option.some(decoded.value);
      });

    // Minting and revoking are the two moments a session's life has, so they are
    // where the counters move (ticket `i1vo`).
    const putSession = (one: Session) =>
      kv
        .put(sessionKey(one.did, one.id), utf8(encodeSession(one)))
        .pipe(Effect.tap(() => Metric.update(sessionsCreated, 1)));

    const deleteSession = (did: string, id: string) =>
      kv
        .delete(sessionKey(did, id))
        .pipe(Effect.tap(() => Metric.update(sessionsRevoked, 1)));

    const prefs = (did: string) =>
      kv
        .get(prefsKey(did))
        .pipe(Effect.map((found) => Option.map(found, (one) => one.value)));

    const putPrefs = (did: string, written: Value) =>
      kv.put(prefsKey(did), written);

    const appPasswords = (did: string) =>
      Effect.gen(function* () {
        const page = yield* kv.scan({
          prefix: appPasswordsUnder(did),
          limit: SCAN_LIMIT,
        });
        return yield* Effect.forEach(page.entries, (entry) => {
          const decoded = decodeAppPassword(text(entry.value));
          return Option.isNone(decoded)
            ? Effect.fail(new CorruptAccount({ key: entry.key }))
            : Effect.succeed(decoded.value);
        });
      });

    const putAppPassword = (did: string, one: AppPassword) =>
      kv.put(appPasswordKey(did, one.name), utf8(encodeAppPassword(one)));

    const deleteAppPassword = (did: string, name: string) =>
      kv.delete(appPasswordKey(did, name));

    const invite = (code: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(inviteKey(code));
        if (Option.isNone(found)) {
          return Option.none<Invite>();
        }
        const decoded = decodeInvite(text(found.value.value));
        return Option.isNone(decoded)
          ? yield* Effect.fail(new CorruptAccount({ key: inviteKey(code) }))
          : Option.some(decoded.value);
      });

    const kemKey = (did: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(kemKeyOf(did));
        if (Option.isNone(found)) {
          return Option.none<StoredKemKey>();
        }
        const decoded = decodeKemKey(text(found.value.value));
        return Option.isNone(decoded)
          ? yield* Effect.fail(new CorruptAccount({ key: kemKeyOf(did) }))
          : decoded;
      });

    const putKemKey = (did: string, one: StoredKemKey) =>
      kv.put(kemKeyOf(did), utf8(encodeKemKey(one)), absentCondition());

    const kemBackfillComplete = kv
      .get(KEM_BACKFILL_KEY)
      .pipe(Effect.map(Option.isSome));

    const markKemBackfillComplete = (at: number) =>
      kv.put(KEM_BACKFILL_KEY, utf8(String(at)));

    const putToken = (did: string, purpose: string, one: OneUseToken) =>
      kv.put(tokenKey(did, purpose), utf8(encodeOneUseToken(one)));

    const token = (did: string, purpose: string) =>
      Effect.gen(function* () {
        const key = tokenKey(did, purpose);
        const found = yield* kv.get(key);
        if (Option.isNone(found)) {
          return Option.none<OneUseToken>();
        }
        const decoded = decodeOneUseToken(text(found.value.value));
        return Option.isNone(decoded)
          ? yield* Effect.fail(new CorruptAccount({ key }))
          : decoded;
      });

    // Spent when it is used, not when it is read: a mistyped token should cost
    // a retry, not another email.
    const deleteToken = (did: string, purpose: string) =>
      kv.delete(tokenKey(did, purpose));

    const putInvite = (one: Invite) =>
      kv.put(inviteKey(one.code), utf8(encodeInvite(one)));

    // Invites are keyed by code, so "mine" is a scan and a filter. An intranet
    // hands out handfuls; index by issuer when someone hands out thousands.
    // ponytail: full scan of I/, add an issuer index if invite counts grow.
    const invitesOf = (did: string) =>
      Effect.gen(function* () {
        const page = yield* kv.scan({ prefix: 'I/', limit: SCAN_LIMIT });
        const decoded = yield* Effect.forEach(page.entries, (entry) => {
          const one = decodeInvite(text(entry.value));
          return Option.isNone(one)
            ? Effect.fail(new CorruptAccount({ key: entry.key }))
            : Effect.succeed(one.value);
        });
        return decoded.filter((one) => one.createdBy === did);
      });

    return AccountStore.of({
      account,
      byHandle,
      list,
      create,
      activate,
      markVerified,
      verifiedAt,
      suspend,
      reinstate,
      remove,
      rehandle,
      setPassword,
      sessions,
      session,
      putSession,
      deleteSession,
      prefs,
      putPrefs,
      appPasswords,
      putAppPassword,
      deleteAppPassword,
      invite,
      putInvite,
      invitesOf,
      kemKey,
      putKemKey,
      kemBackfillComplete,
      markKemBackfillComplete,
      putToken,
      token,
      deleteToken,
    });
  }),
);
