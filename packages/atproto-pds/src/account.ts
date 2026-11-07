import {
  ACCESS_SCOPE,
  REFRESH_SCOPE,
  REFRESH_TTL_SECONDS,
  accessToken,
  refreshToken,
  serviceAuthToken,
} from './token.js';
import {
  type Account,
  type AccountStatus,
  type AccountStore,
  type AppPassword,
  type Session,
} from './account-store.js';
import { Effect, Match, Option, Schema } from 'effect';
import { type HandleDns, announceHandle, forgetHandle } from './handle-dns.js';
import {
  type PdsConfig,
  authenticate,
  bearer,
  forbidden,
  invalid,
  notFound,
  serverError,
  storeError,
  unauthorized,
} from './pds.js';
import { RepoStore, createRepo } from '@eoa/repo-store';
import { XrpcError, type XrpcServer } from '@eoa/xrpc-server';
import {
  digestSecret,
  hashPassword,
  newAppPassword,
  newInviteCode,
  randomId,
  sameSecret,
  verifyPassword,
} from './password.js';
import type { DpopReplay } from './dpop-replay.js';
import type { Firehose } from './firehose.js';
import { type Mail } from './mail.js';
import { documentHostOf } from './did-web.js';
import { ensureKemKey } from './kem.js';
import { proofOfControl } from './proof.js';

/**
 * Accounts, sessions, app passwords and invites (the Effect-PDS map, `wrds`).
 *
 * The account itself follows `account-lifecycle.qnt` and nothing else; the
 * surface is a mapping onto its actions, so `createAccount` is the spec's
 * `create` then `activate` (atproto creates a live account), `deactivateAccount`
 * is `suspend`, and `deleteAccount` is `deleteAccount` — handle release and all.
 *
 * The rest is here because a session needs it, not because it is a state
 * machine: a session is valid while its row exists and its account is `active`,
 * and an app password is a credential that can be handed to a robot without
 * handing it the account's own.
 */

const CreateAccountSchema = Schema.Struct({
  handle: Schema.String,
  password: Schema.String,
  email: Schema.optional(Schema.String),
  inviteCode: Schema.optional(Schema.String),
  did: Schema.optional(Schema.String),
});

const CreateSessionSchema = Schema.Struct({
  identifier: Schema.String,
  password: Schema.String,
});

const ActivateSchema = Schema.Struct({
  identifier: Schema.String,
  password: Schema.String,
});

const DeleteAccountSchema = Schema.Struct({
  did: Schema.String,
  // Either proves ownership: a password proves the person, a token proves the
  // mailbox the deletion was requested from. A caller sends the one it has.
  password: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
});

const RequestAccountDeleteSchema = Schema.Struct({ did: Schema.String });

const ConfirmEmailSchema = Schema.Struct({
  email: Schema.String,
  token: Schema.String,
});

/** How long a one-use token is good for — a deletion, or a verification. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const CreateAppPasswordSchema = Schema.Struct({
  name: Schema.String,
  privileged: Schema.optional(Schema.Boolean),
});

const RevokeAppPasswordSchema = Schema.Struct({ name: Schema.String });

/** A password a person typed. The spec only says a string; a length floor is ours. */
const UpdatePasswordSchema = Schema.Struct({
  password: Schema.String.check(Schema.isMinLength(8)),
});

const ResetPasswordSchema = Schema.Struct({
  did: Schema.String,
  password: Schema.String.check(Schema.isMinLength(8)),
});

const CreateInviteCodeSchema = Schema.Struct({
  useCount: Schema.Number,
  forAccount: Schema.optional(Schema.String),
});

const CreateInviteCodesSchema = Schema.Struct({
  codeCount: Schema.Number,
  useCount: Schema.Number,
  forAccount: Schema.optional(Schema.String),
});

/**
 * `getServiceAuth`: who the token is for, how long it lives, and what it may be used on.
 *
 * Query parameters arrive as strings — the method is a `GET` — and reading them off the body (`ctx.input`)
 * is what made every proof a move needs impossible to mint: the body of a `GET` is empty, so the
 * schema refused before the token was ever built. `exp` is an absolute unix time in the lexicon; it is
 * converted here rather than read as a number the wire never writes.
 */
const GetServiceAuthSchema = Schema.Struct({
  aud: Schema.String,
  exp: Schema.optional(Schema.String),
  lxm: Schema.optional(Schema.String),
});

/** A handle's label: letters, digits and hyphens, never leading or trailing. */
const HANDLE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;

/** An app password's name, which is also its row key. */
const APP_PASSWORD_NAME = /^[a-zA-Z0-9_-]{1,32}$/u;

/**
 * A handle is ours to hold when it ends in our domain — that is the whole
 * check, and it is why a handle is `name.domain` and the DID is `did:web:handle`:
 * the handle is already a domain, so nothing has to be resolved to trust it.
 */
export const validHandle = (handle: string, domain: string) => {
  const suffix = `.${domain.toLowerCase()}`;
  if (!handle.endsWith(suffix)) {
    return false;
  }
  const label = handle.slice(0, handle.length - suffix.length);
  return (
    label.length > 0 &&
    label.split('.').every((part) => HANDLE_LABEL.test(part))
  );
};

/** A moment, as atproto writes one. */
const isoOf = (at: number) => new Date(at).toISOString();

/**
 * Tell the public firehose that an account's status moved — and only when it moved.
 *
 * The store's moves are the spec's: `suspend` on a suspended account writes nothing, and an
 * event for a non-event would make every reader hide a member twice. So the event goes out
 * after the write, when the row the write returned differs from the one it was asked about.
 */
const announceStatus = (
  deps: AccountSurfaceDeps,
  before: AccountStatus,
  after: Account,
) => {
  if (after.status === before || deps.firehose === undefined) {
    return Effect.void;
  }
  const now = Date.now();
  return Effect.asVoid(
    deps.firehose.emitAccount({
      time: isoOf(now),
      timeUs: now * 1000,
      did: after.did,
      active: after.status === 'active',
      status: after.status,
    }),
  );
};

/** What the account surface needs: the store, the repo model, and who we are. */
export interface AccountSurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly repo: RepoStore['Service'];
  readonly replay: DpopReplay['Service'];
  readonly mail: Mail['Service'];
  /**
   * Where a handle's external answer is written (`a34b`): the `_atproto` record. Absent means this
   * deployment resolves handles some other way — a host that serves `/.well-known/atproto-did` for
   * every name, or an operator who publishes by hand.
   */
  readonly handleDns?: HandleDns | undefined;
  /**
   * The public stream, when this deployment has one: an account's status move is the one
   * thing a member's going away has to say out loud (`lfmr`). Absent means nobody is told.
   */
  readonly firehose?: Firehose['Service'] | undefined;
}

/** The account a login names, by handle or by DID. */
const resolveAccount = (deps: AccountSurfaceDeps, identifier: string) =>
  (identifier.startsWith('did:')
    ? deps.accounts.account(identifier)
    : deps.accounts.byHandle(identifier.toLowerCase())
  ).pipe(Effect.mapError(() => serverError('the account could not be read')));

/** The account's tokens, for a session that already exists. */
const tokensFor = (
  deps: AccountSurfaceDeps,
  account: Account,
  sessionId: string,
  now: number,
) =>
  Effect.gen(function* () {
    const request = {
      key: deps.config.signingKey,
      did: account.did,
      audience: deps.config.did,
      sessionId,
      now,
    };
    const accessJwt = yield* accessToken(request).pipe(
      Effect.mapError(() =>
        serverError('the access token could not be signed'),
      ),
    );
    const refreshJwt = yield* refreshToken(request).pipe(
      Effect.mapError(() =>
        serverError('the refresh token could not be signed'),
      ),
    );
    return { accessJwt, refreshJwt };
  });

/**
 * A new session: a row, and the pair of tokens that name it. The row is what
 * makes the tokens revocable, so it is written first — a token without a row
 * would be a token nobody could take back.
 */
const openSession = (
  deps: AccountSurfaceDeps,
  params: {
    readonly account: Account;
    readonly appPasswordName: string | null;
    readonly now: number;
  },
) =>
  Effect.gen(function* () {
    const id = randomId();
    const session: Session = {
      id,
      did: params.account.did,
      appPasswordName: params.appPasswordName,
      createdAt: params.now,
      expiresAt: params.now + REFRESH_TTL_SECONDS * 1000,
    };
    yield* deps.accounts
      .putSession(session)
      .pipe(
        Effect.mapError(() => serverError('the session could not be written')),
      );
    const tokens = yield* tokensFor(deps, params.account, id, params.now);
    return { ...tokens, session };
  });

/**
 * Which of the account's app passwords this secret is, if any.
 *
 * A digest each, not a KDF each: app passwords are random, so checking them is
 * a comparison, and an account has a handful.
 */
const findAppPassword = (
  deps: AccountSurfaceDeps,
  did: string,
  secret: string,
) =>
  Effect.gen(function* () {
    const passwords = yield* deps.accounts
      .appPasswords(did)
      .pipe(
        Effect.mapError(() =>
          serverError('the app passwords could not be read'),
        ),
      );
    const matched = yield* Effect.forEach(passwords, (one) =>
      sameSecret(secret, one.digest).pipe(
        Effect.mapError(() => serverError('the secret could not be checked')),
        Effect.map((same) =>
          same ? Option.some(one) : Option.none<AppPassword>(),
        ),
      ),
    );
    return Option.firstSomeOf(matched);
  });

/** The password a proof of ownership is checked against. */
const provesOwnership = (
  deps: AccountSurfaceDeps,
  account: Account,
  password: string,
) =>
  verifyPassword(password, account.passwordHash).pipe(
    Effect.mapError(() => serverError('the password could not be checked')),
    Effect.flatMap((genuine) =>
      genuine
        ? Effect.succeed(account)
        : Effect.fail(unauthorized('invalid identifier or password')),
    ),
  );

/**
 * A deletion token proves the mailbox it was sent to: one use, and it expires.
 * It is spent when it *works*, not when it is presented — a mistyped token
 * should cost a retry rather than another email, and with 256 bits behind it
 * there is nothing to be gained by burning it on a wrong guess.
 */
const provesToken = (
  deps: AccountSurfaceDeps,
  account: Account,
  token: string,
) =>
  Effect.gen(function* () {
    const held = yield* deps.accounts
      .token(account.did, 'delete')
      .pipe(
        Effect.mapError(() =>
          serverError('the deletion token could not be read'),
        ),
      );
    if (Option.isNone(held)) {
      return yield* Effect.fail(unauthorized('no deletion was requested'));
    }
    if (held.value.expiresAt < Date.now()) {
      return yield* Effect.fail(unauthorized('the deletion token has expired'));
    }
    const same = yield* sameSecret(token, held.value.digest).pipe(
      Effect.mapError(() =>
        serverError('the deletion token could not be checked'),
      ),
    );
    if (!same) {
      return yield* Effect.fail(unauthorized('invalid deletion token'));
    }
    yield* deps.accounts
      .deleteToken(account.did, 'delete')
      .pipe(
        Effect.mapError(() =>
          serverError('the deletion token could not be spent'),
        ),
      );
    return account;
  });

export const registerAccountMethods = (
  server: XrpcServer,
  deps: AccountSurfaceDeps,
) => {
  server.method('com.atproto.server.createAccount', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(CreateAccountSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createAccount'));
      }
      const input = decoded.value;
      const now = Date.now();
      const handle = input.handle.toLowerCase();
      if (!validHandle(handle, deps.config.domain)) {
        return yield* Effect.fail(
          invalid(`a handle here looks like name.${deps.config.domain}`),
        );
      }
      // The DID is **not** derived from the handle, because the spec releases a
      // handle on deletion and a released handle has to be takeable by a *new*
      // account — which means a new DID. A did:web with a random path segment
      // is resolvable in principle and independent of the name.
      //
      // **The host has to be one that serves the document.** `did:web:<host>:<id>` resolves at
      // `https://<host>/<id>/did.json`, and only this PDS's own name is a host it answers on. The
      // handle's domain is where *handles* live, and its apex belongs to whoever runs the site —
      // and minted under it, as ours were, an account's identity pointed at a document nothing
      // served. `documentHostOf` prefers the public URL for exactly this reason.
      const did =
        input.did ?? `did:web:${documentHostOf(deps.config)}:${randomId()}`;
      // A DID this PDS mints is ours to hand out, so it needs nothing said about it. Any **other**
      // DID is somebody else's identity, and the proof is *required* rather than optional: without
      // it a caller could name any identity, and a move would be indistinguishable from a copy.
      // This is the step a mover's `Destination` port depends on (`rnm4`).
      const hosted = `did:web:${documentHostOf(deps.config)}`;
      if (
        input.did !== undefined &&
        input.did !== hosted &&
        !input.did.startsWith(`${hosted}:`)
      ) {
        const presented = bearer(ctx);
        if (presented === undefined) {
          return yield* Effect.fail(
            unauthorized(
              `${did} is not an identity this PDS holds: create it with a service-auth token from the PDS that does`,
            ),
          );
        }
        yield* proofOfControl({
          did,
          token: presented,
          // The audience is this PDS's own DID — the destination decides who it is, never the token.
          audience: deps.config.did,
          lxm: 'com.atproto.server.createAccount',
          plcDirectoryUrl: deps.config.plcDirectoryUrl,
          // Absent is the network: a deployment resolves the DID document where its method says it
          // lives. A rehearsal binds this to the server it started (`b49d`, `gd0x`).
          ...(deps.config.fetchDocument === undefined
            ? {}
            : { fetchDocument: deps.config.fetchDocument }),
          now,
        }).pipe(Effect.mapError((cause) => unauthorized(cause.reason)));
      }
      const passwordHash = yield* hashPassword(
        input.password,
        deps.config.passwordIterations,
      ).pipe(
        Effect.mapError(() => serverError('the password could not be hashed')),
      );
      const outcome = yield* deps.accounts
        .create({
          did,
          handle,
          email: input.email ?? null,
          passwordHash,
          inviteCode: input.inviteCode,
          inviteRequired: deps.config.inviteCodeRequired ?? false,
          now,
        })
        .pipe(
          Effect.mapError((cause) =>
            storeError('the account could not be created', cause),
          ),
        );
      // A refusal here is the spec's: a taken handle leaves the account absent.
      yield* Match.value(outcome).pipe(
        Match.tag('created', (one) => Effect.succeed(one.account)),
        Match.tag('handleTaken', (one) =>
          Effect.fail(invalid(`the handle ${one.handle} is taken`)),
        ),
        Match.tag('alreadyExists', (one) =>
          Effect.fail(invalid(`the account ${one.did} is already here`)),
        ),
        Match.tag('inviteRequired', () =>
          Effect.fail(invalid('an invite code is required')),
        ),
        Match.tag('inviteInvalid', (one) =>
          Effect.fail(invalid(`the invite code ${one.code} is not usable`)),
        ),
        Match.exhaustive,
      );
      // The repo is the account's, so it is made after it: a failure here
      // leaves an account with no repo, which a retry finishes, while the other
      // order would leave a repo nobody owns.
      // ponytail: the account store and the repo store are not one transaction.
      yield* createRepo({
        did,
        signingKey: deps.config.signingKey,
        now,
        clockId: deps.config.clockId,
      }).pipe(
        Effect.provideService(RepoStore, deps.repo),
        Effect.mapError(() => serverError('the repo could not be created')),
      );
      // The account's own `#atproto_kem` key (spaces alpha, 2026-10-22, §7): a
      // dedicated P-256 pair, generated here rather than reused from the signing
      // key, because it is per-account and must never be one that can sign.
      //
      // Nothing is published from here. A `did:web` document is the owner's, and
      // a migrated `did:plc` still points at the server it came from — the key
      // reaches the directory through `getRecommendedDidCredentials` and the
      // operation the migration submits.
      yield* ensureKemKey({ accounts: deps.accounts, did, now }).pipe(
        Effect.mapError(() =>
          serverError('the account key could not be created'),
        ),
      );
      // The spec's `create`, then `activate` — atproto creates a live account.
      const activated = yield* deps.accounts
        .activate(did)
        .pipe(
          Effect.mapError(() =>
            serverError('the account could not be activated'),
          ),
        );
      if (Option.isNone(activated)) {
        return yield* Effect.fail(
          serverError('the account went missing while it was being created'),
        );
      }
      // The handle's external answer, now that there is an account behind it. A failure here is
      // logged rather than raised: the account exists, and a record can be published again.
      yield* announceHandle(deps.handleDns, {
        handle: activated.value.handle,
        did: activated.value.did,
      });
      const opened = yield* openSession(deps, {
        account: activated.value,
        appPasswordName: null,
        now,
      });
      return {
        accessJwt: opened.accessJwt,
        refreshJwt: opened.refreshJwt,
        handle: activated.value.handle,
        did: activated.value.did,
      };
    }),
  );

  server.method('com.atproto.server.createSession', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(CreateSessionSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createSession'));
      }
      const { identifier, password } = decoded.value;
      const found = yield* resolveAccount(deps, identifier);
      if (Option.isNone(found)) {
        // The same words whether the account is missing or the password is
        // wrong: which one it was is not the client's business.
        return yield* Effect.fail(
          unauthorized('invalid identifier or password'),
        );
      }
      const account = found.value;
      // An app password is a digest and the account's is a KDF, so the cheap
      // one is asked first — a secret is one or the other, never both.
      const appPassword = yield* findAppPassword(deps, account.did, password);
      const genuine = Option.isSome(appPassword)
        ? true
        : yield* verifyPassword(password, account.passwordHash).pipe(
            Effect.mapError(() =>
              serverError('the password could not be checked'),
            ),
          );
      if (!genuine) {
        return yield* Effect.fail(
          unauthorized('invalid identifier or password'),
        );
      }
      if (account.status !== 'active') {
        return yield* Effect.fail(
          new XrpcError({
            error: 'AccountTakedown',
            message: `the account is ${account.status}`,
            status: 400,
          }),
        );
      }
      const opened = yield* openSession(deps, {
        account,
        appPasswordName: Option.isNone(appPassword)
          ? null
          : appPassword.value.name,
        now: Date.now(),
      });
      return {
        accessJwt: opened.accessJwt,
        refreshJwt: opened.refreshJwt,
        handle: account.handle,
        did: account.did,
        active: true,
      };
    }),
  );

  server.method('com.atproto.server.refreshSession', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, REFRESH_SCOPE);
      // The same session, a fresh pair — no new row, so refreshing is not a
      // way to accumulate sessions.
      const tokens = yield* tokensFor(
        deps,
        caller.account,
        caller.session.id,
        Date.now(),
      );
      return {
        accessJwt: tokens.accessJwt,
        refreshJwt: tokens.refreshJwt,
        handle: caller.account.handle,
        did: caller.account.did,
      };
    }),
  );

  server.method('com.atproto.server.deleteSession', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, REFRESH_SCOPE);
      yield* deps.accounts
        .deleteSession(caller.account.did, caller.session.id)
        .pipe(
          Effect.mapError(() =>
            serverError('the session could not be deleted'),
          ),
        );
      return {};
    }),
  );

  /**
   * The account's password changes here, and the sessions that were opened with the old
   * one stop working — a session is valid while its row exists, so deleting the rows is
   * the whole of it. The caller's own session survives: it is the one that proved it may
   * do this, and signing the person out of the page they are on is not a security gain.
   *
   * An app password cannot call this: it is a credential for a program, and a program
   * that can rotate the account's password can lock the person out of it.
   */
  server.method('com.atproto.server.updatePassword', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      if (caller.session.appPasswordName !== null) {
        return yield* Effect.fail(
          forbidden('an app password cannot change the account password'),
        );
      }
      const decoded = Schema.decodeUnknownOption(UpdatePasswordSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          invalid('a password is at least 8 characters'),
        );
      }
      const passwordHash = yield* hashPassword(decoded.value.password).pipe(
        Effect.mapError(() => serverError('the password could not be hashed')),
      );
      const written = yield* deps.accounts
        .setPassword(caller.account.did, passwordHash)
        .pipe(
          Effect.mapError(() =>
            serverError('the password could not be written'),
          ),
        );
      if (Option.isNone(written)) {
        return yield* Effect.fail(unauthorized('no such account'));
      }
      // Other sessions go, in parallel; the caller's own stays.
      const held = yield* deps.accounts
        .sessions(caller.account.did)
        .pipe(
          Effect.mapError(() => serverError('the sessions could not be read')),
        );
      yield* Effect.forEach(
        held.filter((one) => one.id !== caller.session.id),
        (one) => deps.accounts.deleteSession(caller.account.did, one.id),
        { discard: true },
      ).pipe(
        Effect.mapError(() => serverError('the sessions could not be revoked')),
      );
      return {};
    }),
  );

  server.method('com.atproto.server.getSession', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const confirmed = yield* deps.accounts
        .verifiedAt(caller.account.did)
        .pipe(
          Effect.mapError(() => serverError('the account could not be read')),
        );
      return {
        handle: caller.account.handle,
        did: caller.account.did,
        active: true,
        emailConfirmed: Option.isSome(confirmed),
      };
    }),
  );

  // atproto's activateAccount takes no input, because it is normally reached
  // through a token in an email. There is no mail here, and a suspended account
  // cannot hold a session to call it with, so it asks for the account's own
  // password: proof of ownership is the only way back.
  server.method('com.atproto.server.activateAccount', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(ActivateSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for activateAccount'));
      }
      const found = yield* resolveAccount(deps, decoded.value.identifier);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          unauthorized('invalid identifier or password'),
        );
      }
      const account = yield* provesOwnership(
        deps,
        found.value,
        decoded.value.password,
      );
      // The spec's `reinstate` from `suspended` and its `activate` from
      // `created`: one API call, the two actions that reach "active".
      const moved = yield* (
        account.status === 'suspended'
          ? deps.accounts.reinstate(account.did)
          : deps.accounts.activate(account.did)
      ).pipe(
        Effect.mapError(() =>
          serverError('the account could not be activated'),
        ),
      );
      if (Option.isNone(moved) || moved.value.status !== 'active') {
        return yield* Effect.fail(
          invalid(`an account that is ${account.status} cannot be activated`),
        );
      }
      // After the write, and only when it moved: activating an active account is the
      // spec's no-op, and it tells nobody anything.
      yield* announceStatus(deps, account.status, moved.value);
      return {};
    }),
  );

  server.method('com.atproto.server.deactivateAccount', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      // The spec's `suspend`: from `active`, and reversible.
      const moved = yield* deps.accounts
        .suspend(caller.account.did)
        .pipe(
          Effect.mapError(() =>
            serverError('the account could not be suspended'),
          ),
        );
      if (Option.isNone(moved) || moved.value.status !== 'suspended') {
        return yield* Effect.fail(
          invalid(
            `an account that is ${caller.account.status} cannot be deactivated`,
          ),
        );
      }
      // A deactivated member is the event: every space that shows their records hears it here.
      yield* announceStatus(deps, caller.account.status, moved.value);
      return {};
    }),
  );

  /**
   * `com.atproto.server.requestEmailVerification` and `confirmEmail`.
   *
   * A verification is the deletion flow's shape with a different purpose: a
   * one-use token by mail, spent when it works, and the account's own row is
   * what records the result. The purpose is in the key, so the two cannot be
   * spent for each other.
   */
  server.method('com.atproto.server.requestEmailVerification', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      if (caller.account.email === null) {
        return yield* Effect.fail(
          invalid('this account has no email to verify'),
        );
      }
      const token = randomId();
      const digest = yield* digestSecret(token).pipe(
        Effect.mapError(() => serverError('the token could not be digested')),
      );
      yield* deps.accounts
        .putToken(caller.account.did, 'verify', {
          digest,
          expiresAt: Date.now() + TOKEN_TTL_MS,
        })
        .pipe(
          Effect.mapError(() => serverError('the token could not be stored')),
        );
      yield* deps.mail
        .send({
          to: caller.account.email,
          subject: 'Verify your email',
          body: `Send this token to com.atproto.server.confirmEmail to verify the address: ${token}`,
        })
        .pipe(
          Effect.mapError(() => serverError('the message could not be sent')),
        );
      return {};
    }),
  );

  server.method('com.atproto.server.confirmEmail', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(ConfirmEmailSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for confirmEmail'));
      }
      if (decoded.value.email !== caller.account.email) {
        return yield* Effect.fail(
          invalid('that is not the address on this account'),
        );
      }
      const held = yield* deps.accounts
        .token(caller.account.did, 'verify')
        .pipe(
          Effect.mapError(() => serverError('the token could not be read')),
        );
      if (Option.isNone(held)) {
        return yield* Effect.fail(invalid('no verification was requested'));
      }
      if (held.value.expiresAt < Date.now()) {
        return yield* Effect.fail(
          invalid('the verification token has expired'),
        );
      }
      const same = yield* sameSecret(
        decoded.value.token,
        held.value.digest,
      ).pipe(
        Effect.mapError(() => serverError('the token could not be checked')),
      );
      if (!same) {
        return yield* Effect.fail(invalid('invalid verification token'));
      }
      yield* deps.accounts
        .markVerified(caller.account.did, Date.now())
        .pipe(
          Effect.mapError(() =>
            serverError('the email could not be confirmed'),
          ),
        );
      yield* deps.accounts
        .deleteToken(caller.account.did, 'verify')
        .pipe(
          Effect.mapError(() => serverError('the token could not be spent')),
        );
      return {};
    }),
  );

  server.method('com.atproto.server.requestAccountDelete', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(RequestAccountDeleteSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          invalid('bad input for requestAccountDelete'),
        );
      }
      const found = yield* resolveAccount(deps, decoded.value.did);
      if (Option.isNone(found)) {
        return yield* Effect.fail(invalid(`no account ${decoded.value.did}`));
      }
      // Only the account itself: asking for someone else's deletion is not a
      // thing a caller gets to do.
      if (found.value.did !== caller.account.did) {
        return yield* Effect.fail(unauthorized('not your account'));
      }
      if (found.value.email === null) {
        return yield* Effect.fail(
          invalid('this account has no email to send a token to'),
        );
      }

      const token = randomId();
      const digest = yield* digestSecret(token).pipe(
        Effect.mapError(() =>
          serverError('the deletion token could not be digested'),
        ),
      );
      yield* deps.accounts
        .putToken(found.value.did, 'delete', {
          digest,
          expiresAt: Date.now() + TOKEN_TTL_MS,
        })
        .pipe(
          Effect.mapError(() =>
            serverError('the deletion token could not be stored'),
          ),
        );
      yield* deps.mail
        .send({
          to: found.value.email,
          subject: 'Delete your account',
          body: `Send this token to com.atproto.server.deleteAccount to delete the account: ${token}`,
        })
        .pipe(
          Effect.mapError(() => serverError('the message could not be sent')),
        );
      return {};
    }),
  );

  server.method('com.atproto.server.deleteAccount', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(DeleteAccountSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for deleteAccount'));
      }
      const { did, password, token } = decoded.value;
      const found = yield* deps.accounts
        .account(did)
        .pipe(
          Effect.mapError(() => serverError('the account could not be read')),
        );
      if (Option.isNone(found)) {
        return yield* Effect.fail(invalid(`no account ${did}`));
      }
      const account =
        token === undefined
          ? yield* provesOwnership(deps, found.value, password ?? '')
          : yield* provesToken(deps, found.value, token);
      if (account.status === 'deleted') {
        return {};
      }
      // The spec's `deleteAccount`: from a live state, releasing the handle.
      const removed = yield* deps.accounts
        .remove(did)
        .pipe(
          Effect.mapError(() =>
            serverError('the account could not be deleted'),
          ),
        );
      if (Option.isNone(removed) || removed.value.status !== 'deleted') {
        return yield* Effect.fail(
          invalid(`an account that is ${account.status} cannot be deleted`),
        );
      }
      // The repo goes with the account, so a deleted account leaves nothing
      // readable behind.
      yield* deps.repo
        .deleteRepo(did)
        .pipe(
          Effect.mapError(() => serverError('the repo could not be deleted')),
        );
      // And the name is released: a record still naming a deleted account would send a resolver to a
      // DID nobody answers for.
      yield* forgetHandle(deps.handleDns, { handle: account.handle });
      return {};
    }),
  );

  server.method('com.atproto.server.createAppPassword', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(CreateAppPasswordSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createAppPassword'));
      }
      const input = decoded.value;
      if (!APP_PASSWORD_NAME.test(input.name)) {
        return yield* Effect.fail(
          invalid('an app password name is letters, digits, - and _, up to 32'),
        );
      }
      const now = Date.now();
      const secret = newAppPassword();
      const digest = yield* digestSecret(secret).pipe(
        Effect.mapError(() =>
          serverError('the app password could not be digested'),
        ),
      );
      const privileged = input.privileged ?? false;
      yield* deps.accounts
        .putAppPassword(caller.account.did, {
          name: input.name,
          digest,
          privileged,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(() =>
            serverError('the app password could not be written'),
          ),
        );
      // The secret is shown once, here: only its digest is kept.
      return {
        name: input.name,
        password: secret,
        createdAt: isoOf(now),
        privileged,
      };
    }),
  );

  server.method('com.atproto.server.listAppPasswords', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const passwords = yield* deps.accounts
        .appPasswords(caller.account.did)
        .pipe(
          Effect.mapError(() =>
            serverError('the app passwords could not be read'),
          ),
        );
      return {
        passwords: passwords.map((one) => ({
          name: one.name,
          createdAt: isoOf(one.createdAt),
          privileged: one.privileged,
        })),
      };
    }),
  );

  server.method('com.atproto.server.revokeAppPassword', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(RevokeAppPasswordSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for revokeAppPassword'));
      }
      yield* deps.accounts
        .deleteAppPassword(caller.account.did, decoded.value.name)
        .pipe(
          Effect.mapError(() =>
            serverError('the app password could not be revoked'),
          ),
        );
      return {};
    }),
  );

  /**
   * `com.atproto.admin.resetPassword` — the way back in when the password is lost.
   *
   * Not the spec's: a PDS with no mailbox binding and no console has no other door, and losing the
   * administrator's password would otherwise mean losing the deployment. It is guarded by a token the
   * deployment must set (`config.recoveryToken`), compared through the same constant-time digest as a
   * login, and a deployment that sets none does not answer it at all.
   */
  server.method('com.atproto.admin.resetPassword', {}, (ctx) =>
    Effect.gen(function* () {
      const expected = deps.config.recoveryToken;
      if (expected === undefined || expected === '') {
        return yield* Effect.fail(
          invalid('this deployment has no recovery token'),
        );
      }
      const presented = bearer(ctx) ?? '';
      // `sameSecret` compares a secret against a **digest**, which is how app passwords are kept; the
      // configured token is the secret itself, so it is digested here and the comparison stays the
      // constant-time one a login uses.
      const wanted = yield* digestSecret(expected).pipe(
        Effect.mapError(() => serverError('the token could not be prepared')),
      );
      const genuine = yield* sameSecret(presented, wanted).pipe(
        Effect.mapError(() => serverError('the token could not be checked')),
      );
      if (!genuine) {
        return yield* Effect.fail(unauthorized('not the recovery token'));
      }
      const decoded = Schema.decodeUnknownOption(ResetPasswordSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for resetPassword'));
      }
      const hash = yield* hashPassword(
        decoded.value.password,
        deps.config.passwordIterations,
      ).pipe(
        Effect.mapError(() => serverError('the password could not be hashed')),
      );
      const written = yield* deps.accounts
        .setPassword(decoded.value.did, hash)
        .pipe(
          Effect.mapError(() =>
            serverError('the password could not be written'),
          ),
        );
      if (Option.isNone(written)) {
        return yield* Effect.fail(invalid(`no account ${decoded.value.did}`));
      }
      // Every session but this call's (which has none) is now a session that outlived the password it
      // was opened with.
      yield* deps.accounts.sessions(decoded.value.did).pipe(
        Effect.flatMap((held) =>
          Effect.forEach(held, (session) =>
            deps.accounts.deleteSession(decoded.value.did, session.id),
          ),
        ),
        Effect.mapError(() => serverError('the sessions could not be ended')),
      );
      return {};
    }),
  );

  server.method('com.atproto.server.createInviteCode', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(CreateInviteCodeSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createInviteCode'));
      }
      const input = decoded.value;
      if (!Number.isInteger(input.useCount) || input.useCount < 1) {
        return yield* Effect.fail(
          invalid('a code is good for at least one use'),
        );
      }
      const now = Date.now();
      const code = newInviteCode();
      yield* deps.accounts
        .putInvite({
          code,
          forAccount: input.forAccount ?? null,
          createdBy: caller.account.did,
          createdAt: now,
          usesAvailable: input.useCount,
          disabled: false,
        })
        .pipe(
          Effect.mapError(() => serverError('the invite could not be written')),
        );
      return { code };
    }),
  );

  server.method('com.atproto.server.createInviteCodes', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(CreateInviteCodesSchema)(
        ctx.input,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for createInviteCodes'));
      }
      const input = decoded.value;
      if (
        !Number.isInteger(input.codeCount) ||
        input.codeCount < 1 ||
        !Number.isInteger(input.useCount) ||
        input.useCount < 1
      ) {
        return yield* Effect.fail(
          invalid(
            'a code is good for at least one use, and there is at least one',
          ),
        );
      }
      const now = Date.now();
      const account = input.forAccount ?? caller.account.did;
      const codes = Array.from({ length: input.codeCount }, () =>
        newInviteCode(),
      );
      yield* Effect.forEach(codes, (code) =>
        deps.accounts
          .putInvite({
            code,
            forAccount: input.forAccount ?? null,
            createdBy: caller.account.did,
            createdAt: now,
            usesAvailable: input.useCount,
            disabled: false,
          })
          .pipe(
            Effect.mapError(() =>
              serverError('an invite could not be written'),
            ),
          ),
      );
      return { codes: codes.map((code) => ({ account, code })) };
    }),
  );

  server.method('com.atproto.server.getAccountInviteCodes', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const invites = yield* deps.accounts
        .invitesOf(caller.account.did)
        .pipe(
          Effect.mapError(() => serverError('the invites could not be read')),
        );
      // `uses` is empty because uses are counted, not logged: a code says how
      // many are left, not who spent them.
      // ponytail: no per-use record. Add one when an audit trail is needed.
      return {
        codes: invites.map((one) => ({
          code: one.code,
          available: one.usesAvailable,
          disabled: one.disabled,
          forAccount: one.forAccount,
          createdBy: one.createdBy,
          createdAt: isoOf(one.createdAt),
          uses: [],
        })),
      };
    }),
  );

  // `checkAccountStatus` is what a migration asks *both* servers: how much each
  // holds. It answers the whole truth about this side — the head, the record
  // count, and whether the account is live — because that is what the other side
  // is compared against before a DID is moved here.
  /**
   * The token that proves this account's DID to another service, which is how a move off this PDS
   * starts: the destination will not take an account for a DID it does not host without one.
   *
   * Signed with the key the account's DID document names, so a verifier resolves the identity and
   * checks against what it finds there rather than trusting anything in the token.
   */
  server.method('com.atproto.server.getServiceAuth', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(GetServiceAuthSchema)(
        ctx.params,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getServiceAuth'));
      }
      const { aud, lxm } = decoded.value;
      const exp =
        decoded.value.exp === undefined ? undefined : Number(decoded.value.exp);
      if (exp !== undefined && !Number.isFinite(exp)) {
        return yield* Effect.fail(invalid('exp is not a unix time'));
      }
      // `exp` is an absolute unix time, as the lexicon has it. A caller that asks for a lifetime
      // gets it rather than a surprise; a caller that asks for nothing gets the short default.
      const now = Date.now();
      const lifetimeSeconds =
        exp === undefined
          ? undefined
          : Math.max(1, Math.floor(exp - Math.floor(now / 1000)));
      const token = yield* serviceAuthToken({
        key: deps.config.signingKey,
        iss: caller.account.did,
        aud,
        lxm,
        now,
        lifetimeSeconds,
      });
      return { token };
    }),
  );

  server.method('com.atproto.server.checkAccountStatus', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const did = caller.account.did;
      const head = yield* deps.repo
        .head(did)
        .pipe(Effect.mapError(() => serverError('the repo could not be read')));
      if (Option.isNone(head)) {
        return yield* Effect.fail(
          notFound('RepoNotFound', `no repo for ${did}`),
        );
      }
      const records = yield* deps.repo
        .leaves(did, '', '\uffff')
        .pipe(Effect.mapError(() => serverError('the repo could not be read')));
      return {
        activated: caller.account.status === 'active',
        validDid: true,
        repoCommit: head.value.root,
        repoRev: head.value.rev,
        indexedRecords: records.length,
      };
    }),
  );
};
