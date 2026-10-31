import { ACCESS_SCOPE, type TokenScope, verifyToken } from './token.js';
import type { Account, AccountStore, Session } from './account-store.js';
import { Effect, Match, Option } from 'effect';
import { type HandlerContext, XrpcError } from '@eoa/xrpc-server';
import {
  type PublicJwk,
  issuerKey,
  verifyAccessToken,
  verifyProof,
} from './oauth.js';
import type { DocumentFetch } from './proof.js';
import type { DpopReplay } from './dpop-replay.js';
import type { PrivateKey } from '@eoa/crypto';

/**
 * What every PDS surface method shares: who this PDS is, how it refuses, and
 * who is speaking.
 *
 * `authenticate` is the one place a request becomes a caller. Every method that
 * needs an identity calls it, so the rules are stated once rather than
 * remembered per handler — and a handler that forgets to call it is a handler
 * that never sees an account, which is a thing a test can notice.
 */

/** The PDS's own identity, and the domain its handles live under. */
export interface PdsConfig {
  readonly did: string;
  readonly domain: string;
  /** The key every commit and every session token is signed with. */
  readonly signingKey: PrivateKey;
  /** Distinguishes two revisions written in the same microsecond. */
  readonly clockId: number;
  /**
   * The PBKDF2 iterations a password is hashed with **in total**, when a deployment wants to name
   * one. Absent is the strong default. The count is not limited to what one call can carry: a
   * count above the runtime's per-call ceiling is spent in rounds, so naming a bigger number buys
   * a bigger number rather than a refusal.
   */
  readonly passwordIterations?: number;
  /**
   * Whether an account needs an invite to be created. Off by default: an
   * intranet has to be able to make its first account, and there is no admin
   * surface yet to mint the invite it would need.
   *
   * // ponytail: default false, because nothing can bootstrap a first invite.
   * // Turn it on once an admin path exists to issue them.
   */
  readonly inviteCodeRequired?: boolean;
  /**
   * The DIDs that may moderate — the org's authority. Nobody by default: an
   * operator names them, and the AaaS layer decides who sets them.
   */
  readonly adminDids?: readonly string[];
  /**
   * A bearer token that may reset any account's password (`com.atproto.admin.resetPassword`).
   *
   * It exists because a PDS with no email reset and no console has exactly one failure mode that is
   * unrecoverable: the operator loses the password to the account that administers it. Absent means
   * the method does not exist — a deployment that has not opted in cannot be reset this way, and one
   * that has carries a credential as powerful as the passwords it replaces.
   */
  readonly recoveryToken?: string;
  /** The most a blob may be, in bytes. Default: 5 MiB. */
  readonly blobLimitBytes?: number;
  /**
   * The blob types this PDS takes: a whole type (`image/png`) or a family
   * (`image/`). No list at all means any type, which is what atproto does.
   */
  readonly allowedBlobTypes?: readonly string[];
  /**
   * How a **DID document** is fetched when an account's control of a DID has to be proven — a move
   * arriving from somewhere else (`proof.ts`). Absent is the live network, which is what a deployment
   * wants; a rehearsal binds it to the source server it just started, because the document a
   * `did:web` identity resolves to is served over a host that has no TLS on a laptop.
   */
  readonly fetchDocument?: DocumentFetch;
  /**
   * The authorization server this PDS takes access tokens from, and the key it
   * signs them with. Absent means OAuth is off and only session tokens are
   * taken — which is what an intranet without an authorization server wants.
   */
  /**
   * The URL clients reach this PDS at, when it is not simply its domain. It is
   * what a DID document points at — and what a deployment behind a proxy needs,
   * since the request's own URL is then the proxy's.
   */
  readonly publicUrl?: string;
  /**
   * The PLC directory this PDS mints and moves `did:plc` accounts through —
   * `https://plc.directory`, or an operator's own. Absent means the PDS only
   * serves `did:web`, which has no rotation and cannot move.
   */
  readonly plcDirectoryUrl?: string;
  /**
   * The key this PDS signs PLC operations with, and lists in `rotationKeys`.
   * Needed whenever `plcDirectoryUrl` is set: an operation whose rotation keys
   * do not name us cannot be submitted by us, and one we sign must.
   */
  readonly plcRotationKey?: PrivateKey;
  /**
   * Serve Jetstream (`GET /jetstream/subscribe`). Off unless named: a closed network does not hand
   * its stream to whoever asks (ADR 0010).
   */
  readonly jetstream?: boolean;
  /**
   * The network operator's offline recovery key, as a did:key — the public half
   * only, since the PDS must *name* it and never hold it. Listed **ahead** of
   * `plcRotationKey` on every operation this PDS recommends or signs, because
   * the order is the authority: only a key listed before the signer may nullify
   * its operation, so this is what makes a move undoable — by the operator, and
   * not by us. Absent means `[plcRotationKey]` alone, as before.
   */
  readonly plcRecoveryDidKey?: string;
  /**
   * The authorization server this PDS takes access tokens from — or, when
   * `privateJwk` is here too, the one it **is**: the provider signs with the
   * private half and the resource server verifies with `jwk`, which the
   * deployment derives from it.
   */
  readonly oauth?: {
    readonly issuer: string;
    readonly jwk: PublicJwk;
    /** Present when this PDS issues tokens: it signs with this key. */
    readonly privateJwk?: JsonWebKey;
  };
  /**
   * Collections whose reads need a session — a closed network's own records.
   *
   * An atproto repo is readable by anyone by design: a PDS that refuses `listRecords` is one no
   * relay can backfill, and that is the point of a public one. This is a deployment saying it is
   * **not** public, and it applies to every read that could carry the records: the listed
   * collections, `repo.getRecord`, and `sync.getRepo`, whose CAR holds every collection at once.
   *
   * A name is a **prefix**: `ing.lexicon.issue` covers `.state`, `.label` and `.labelOp`, which are
   * the same issue read three other ways.
   */
  readonly privateCollections?: readonly string[];
}

/**
 * Whether a collection is one the deployment keeps behind a session. The prefix rule is the whole
 * of it: a record's collection is the only thing a read addresses, so this is what every gate asks.
 */
export const isPrivateCollection = (
  config: PdsConfig,
  collection: string,
): boolean =>
  (config.privateCollections ?? []).some(
    (one) => collection === one || collection.startsWith(`${one}.`),
  );

/** The client asked for something we cannot do. */
export const invalid = (message: string) =>
  new XrpcError({ error: 'InvalidRequest', message, status: 400 });

/** The client did not say who it is, or said it wrong. */
export const unauthorized = (message: string) =>
  new XrpcError({ error: 'AuthRequired', message, status: 401 });

/** The client said who it is, and it is someone else's. */
export const forbidden = (message: string) =>
  new XrpcError({ error: 'Forbidden', message, status: 403 });

/** The thing changed under the caller: read it again and retry. */
export const conflict = (error: string, message: string) =>
  new XrpcError({ error, message, status: 409 });

/** The thing asked for is not here — named as atproto names it. */
export const notFound = (error: string, message: string) =>
  new XrpcError({ error, message, status: 400 });

/** The account was taken down, so it is not served. */
export const takenDown = (message: string) =>
  new XrpcError({ error: 'AccountTakedown', message, status: 400 });

/**
 * A store that could not answer, saying **what it said**.
 *
 * The generic sentence is what made `tie8` opaque: the PDS knew the Durable Object had refused a value
 * (`KvUnavailable`, with its own words), and told the operator "the session could not be written". The
 * logs could not be read from where the incident was found — `wrangler tail` needs a WebSocket this
 * network does not carry — so the message is the only channel there was, and it said nothing.
 *
 * On an intranet, including it costs nothing the operator does not already have.
 */
export const storeError = (what: string, cause: unknown) => {
  const said = cause instanceof Error ? cause.message : String(cause);
  return serverError(`${what}: ${said}`);
};

/** The store could not answer, which is ours to be sorry for. */
export const serverError = (message: string) =>
  new XrpcError({ error: 'InternalServerError', message, status: 500 });

/**
 * The DID a **reader** may be served. A session already decides this for a
 * writer — `authenticate` is a predicate over the account's status — but a
 * reader has no session, so the status has to be asked for: an account that was
 * taken down stops being served rather than answering with its content.
 */
export const readableDid = (
  deps: { readonly accounts: AccountStore['Service'] },
  name: string,
) =>
  Effect.gen(function* () {
    const did = yield* resolveDid(deps, name);
    const found = yield* deps.accounts
      .account(did)
      .pipe(
        Effect.mapError(() => serverError('the account could not be read')),
      );
    if (Option.isSome(found) && found.value.status !== 'active') {
      return yield* Effect.fail(
        takenDown(`the account for ${did} is ${found.value.status}`),
      );
    }
    return did;
  });

/** An account, and the session it is speaking through. */
export interface Caller {
  readonly account: Account;
  readonly session: Session;
}

export interface AuthDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly replay: DpopReplay['Service'];
}

/** The scope an OAuth access token must carry to be usable here. */
export const OAUTH_SCOPE = 'atproto';

/**
 * Who a *resource* request is: an account, however it proved itself.
 *
 * A session names one through a row, an OAuth token through a key; both end at
 * the same question — is this an active account — which is the only thing the
 * repo and blob surfaces need to know.
 */
export interface ResourceCaller {
  readonly account: Account;
}

const secondsNow = () => Math.floor(Date.now() / 1000);

/** The DID a request names — a repo is addressed by handle as well as by DID. */
export const resolveDid = (
  deps: { readonly accounts: AccountStore['Service'] },
  repo: string,
) =>
  repo.startsWith('did:')
    ? Effect.succeed(repo)
    : deps.accounts.byHandle(repo.toLowerCase()).pipe(
        Effect.mapError(() => serverError('the account could not be read')),
        Effect.flatMap((found) =>
          Option.isNone(found)
            ? Effect.fail(notFound('RepoNotFound', repo))
            : Effect.succeed(found.value.did),
        ),
      );

/** The account a DID names, when it is here and active. */
const activeAccount = (deps: AuthDeps, did: string) =>
  Effect.gen(function* () {
    const found = yield* deps.accounts
      .account(did)
      .pipe(
        Effect.mapError(() => serverError('the account could not be read')),
      );
    if (Option.isNone(found)) {
      return yield* Effect.fail(unauthorized('the account is gone'));
    }
    if (found.value.status !== 'active') {
      return yield* Effect.fail(
        unauthorized(`the account is ${found.value.status}`),
      );
    }
    return found.value;
  });

/**
 * An OAuth caller: an access token from the issuer we trust, and a proof made
 * with the key that token was issued to, for **this** request.
 *
 * The order matters. The token is checked first, because it is what says which
 * key the proof must be made with; the proof is checked next, because it is what
 * proves the caller holds that key; and only then is the pair worth asking the
 * account store about.
 */
const authenticateOAuth = (
  deps: AuthDeps,
  ctx: HandlerContext,
  token: string,
) =>
  Effect.gen(function* () {
    const oauth = deps.config.oauth;
    if (oauth === undefined) {
      return yield* Effect.fail(
        unauthorized('this PDS does not take OAuth tokens'),
      );
    }
    const proof = ctx.headers['dpop'];
    if (proof === undefined) {
      return yield* Effect.fail(
        unauthorized('an OAuth token needs a DPoP proof'),
      );
    }
    if (ctx.method === undefined || ctx.url === undefined) {
      return yield* Effect.fail(
        serverError('the request is missing its method or URL'),
      );
    }
    // ponytail: the issuer's key is imported per request. Import it once at
    // startup when OAuth is on the hot path.
    const key = yield* issuerKey(oauth.jwk).pipe(
      Effect.mapError(() =>
        serverError('the configured issuer key is not usable'),
      ),
    );
    const claims = yield* verifyAccessToken({
      token,
      issuer: oauth.issuer,
      audience: deps.config.did,
      key,
      now: secondsNow(),
    }).pipe(Effect.mapError((error) => unauthorized(error.message)));
    if (!claims.scope.includes(OAUTH_SCOPE)) {
      return yield* Effect.fail(
        forbidden(`the token does not carry the ${OAUTH_SCOPE} scope`),
      );
    }

    const verified = yield* verifyProof({
      proof,
      htm: ctx.method,
      htu: ctx.url,
      accessToken: token,
      now: secondsNow(),
    }).pipe(Effect.mapError((error) => unauthorized(error.message)));
    if (verified.jkt !== claims.jkt) {
      return yield* Effect.fail(
        unauthorized('the proof is not from the key the token was issued to'),
      );
    }

    const outcome = yield* deps.replay
      .submit({ jti: verified.jti, iat: verified.iat, now: secondsNow() })
      .pipe(
        Effect.mapError(() =>
          serverError('the replay record could not be read'),
        ),
      );
    yield* Match.value(outcome).pipe(
      Match.tag('fresh', () => Effect.void),
      Match.tag('seen', () =>
        Effect.fail(unauthorized('that proof has already been used')),
      ),
      Match.exhaustive,
    );

    return { account: yield* activeAccount(deps, claims.did) };
  });

/**
 * The caller behind a resource request: a session token (`Bearer`) or an OAuth
 * access token (`DPoP`), whichever the client holds.
 */
export const authenticateAccess = (deps: AuthDeps, ctx: HandlerContext) =>
  Effect.gen(function* () {
    const header = ctx.headers['authorization'] ?? '';
    if (header.startsWith('DPoP ')) {
      return yield* authenticateOAuth(
        deps,
        ctx,
        header.slice('DPoP '.length).trim(),
      );
    }
    return { account: (yield* authenticate(deps, ctx, ACCESS_SCOPE)).account };
  });

/** The token a caller presents, if any — a session token, or one addressed to this PDS. */
export const bearer = (ctx: HandlerContext) => {
  const header = ctx.headers['authorization'] ?? '';
  return header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : undefined;
};

/**
 * The caller behind a request, or a 401.
 *
 * A token proves *which* session is speaking — its `jti` — and three things
 * then decide whether it may: the session row exists (so a deleted session is
 * dead at once, not at expiry), the account is **active** (so suspending an
 * account stops its tokens without touching them, and reinstating brings them
 * back), and the session has not outlived itself.
 */
export const authenticate = (
  deps: AuthDeps,
  ctx: HandlerContext,
  scope: TokenScope,
) =>
  Effect.gen(function* () {
    const token = bearer(ctx);
    if (token === undefined) {
      return yield* Effect.fail(unauthorized('an access token is required'));
    }
    const payload = yield* verifyToken({
      key: deps.config.signingKey.publicKey,
      token,
      audience: deps.config.did,
      scope,
      now: Date.now(),
    }).pipe(Effect.mapError(() => unauthorized('the token is not valid')));
    const found = yield* deps.accounts
      .session(payload.sub, payload.jti)
      .pipe(
        Effect.mapError(() => serverError('the session could not be read')),
      );
    if (Option.isNone(found)) {
      return yield* Effect.fail(unauthorized('the session is gone'));
    }
    const account = yield* deps.accounts
      .account(payload.sub)
      .pipe(
        Effect.mapError(() => serverError('the account could not be read')),
      );
    if (Option.isNone(account)) {
      return yield* Effect.fail(unauthorized('the account is gone'));
    }
    if (account.value.status !== 'active') {
      return yield* Effect.fail(
        unauthorized(`the account is ${account.value.status}`),
      );
    }
    if (found.value.expiresAt <= Date.now()) {
      return yield* Effect.fail(unauthorized('the session has expired'));
    }
    return { account: account.value, session: found.value };
  });
