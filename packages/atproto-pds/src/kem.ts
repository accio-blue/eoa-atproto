import {
  type Account,
  type AccountStore,
  type StoredKemKey,
} from './account-store.js';
import {
  CryptoError,
  type PrivateKey,
  base64urlDecode,
  base64urlEncode,
  compressPoint,
  createDIDKey,
  formatP256DidKey,
  generateP256SecretKey,
  p256PublicPoint,
} from '@eoa/crypto';
import { Effect, Option } from 'effect';
import { buildOperation, signOperation } from '@eoa/identity';
import {
  currentOperationCid,
  currentOperationData,
  submitOperation,
} from '@eoa/identity';
import type { Firehose } from './firehose.js';

/**
 * The account's dedicated `#atproto_kem` key (spaces alpha, 2026-10-22, §4b/§7).
 *
 * A space repo's responses are authenticated with a per-request shared secret,
 * and the secret is agreed against a key that never signs anything: a syncer
 * encapsulates against the account's **public** KEM key, this host decapsulates
 * with the private half. That separation is the point — a leaked signing key
 * cannot forge a shared secret, and a leaked KEM key cannot sign a commit.
 *
 * The pair is P-256 and per-account, so it is generated here rather than taken
 * from config: every account gets its own, and its public half is what the
 * account's DID document carries as `verificationMethods.atproto_kem`.
 */

/** The account's keypair, as the crypto calls want it. */
export interface AccountKemKey {
  /** The 32-byte secret scalar. */
  readonly secretKey: Uint8Array;
  /** The public half as a P-256 `did:key` — the value the DID document carries. */
  readonly didKey: string;
}

/** The `#atproto_kem` verification method's `id`, for a DID. */
export const kemKeyIdOf = (did: string) => `${did}#atproto_kem`;

/** A fresh keypair, stored nowhere: the caller decides where it lives. */
export const newKemKey: Effect.Effect<AccountKemKey, CryptoError> = Effect.gen(
  function* () {
    const secretKey = yield* generateP256SecretKey();
    const publicKey = yield* p256PublicPoint(secretKey);
    return {
      secretKey,
      didKey: yield* Effect.try({
        try: () => formatP256DidKey(compressPoint(publicKey)),
        catch: (cause) => new CryptoError({ cause, operation: 'p256' }),
      }),
    };
  },
);

/** A stored row, read back as the pair the crypto calls take. */
export const kemKeyOf = (stored: StoredKemKey) => ({
  secretKey: base64urlDecode(stored.secret),
  didKey: stored.didKey,
});

/** The row a keypair is written as. */
const storedKemKey = (key: AccountKemKey, now: number) => ({
  secret: base64urlEncode(key.secretKey),
  didKey: key.didKey,
  createdAt: now,
});

/**
 * The account's key, generated and stored the first time it is asked for.
 *
 * Idempotent by construction: the write is conditional on the row being absent,
 * so an account that already has a key keeps it — a second key would be one the
 * published DID document does not name — and two hosts racing agree on whichever
 * row won.
 */
export const ensureKemKey = (params: {
  readonly accounts: AccountStore['Service'];
  readonly did: string;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const held = yield* params.accounts.kemKey(params.did);
    if (Option.isSome(held)) {
      return kemKeyOf(held.value);
    }
    const key = yield* newKemKey;
    const written = yield* params.accounts
      .putKemKey(params.did, storedKemKey(key, params.now))
      .pipe(
        Effect.as(Option.none<StoredKemKey>()),
        // Somebody wrote one first: theirs is the one the document will name.
        Effect.catchTag('KeyPreconditionFailed', () =>
          params.accounts.kemKey(params.did),
        ),
      );
    return Option.isNone(written) ? key : kemKeyOf(written.value);
  });

/** The account's key, when it has one — for the DID document and the PLC check. */
export const heldKemKey = (params: {
  readonly accounts: AccountStore['Service'];
  readonly did: string;
}) =>
  params.accounts
    .kemKey(params.did)
    .pipe(Effect.map(Option.map((stored) => kemKeyOf(stored))));

/** What the backfill reads out of a deployment: nothing else, so a host may pass its own shape. */
export interface KemBackfillConfig {
  readonly domain: string;
  readonly publicUrl?: string | undefined;
  readonly plcDirectoryUrl?: string | undefined;
  readonly plcRotationKey?: PrivateKey | undefined;
}

/** This PDS's PLC settings, or nothing when it serves `did:web` only. */
const plcOf = (config: KemBackfillConfig) =>
  config.plcDirectoryUrl === undefined || config.plcRotationKey === undefined
    ? undefined
    : { url: config.plcDirectoryUrl, key: config.plcRotationKey };

/** The endpoint a DID document points at to reach this PDS. */
export const endpointOf = (config: KemBackfillConfig) =>
  config.publicUrl ?? `https://${config.domain}`;

/**
 * How one account went: published to the directory, stored but left for its
 * owner, skipped because it is deleted, or failed and therefore retried.
 */
type KemBackfillOutcome = {
  readonly did: string;
  readonly handle: string;
  readonly outcome: 'published' | 'unpublished' | 'skipped' | 'failed';
};

/** How one account went, named once so every branch reads the same. */
const went = (account: Account, outcome: KemBackfillOutcome['outcome']) => ({
  did: account.did,
  handle: account.handle,
  outcome,
});

/** What a backfill run did: the counts, and which accounts need a human. */
export interface KemBackfillReport {
  /** False when a previous run already completed — nothing was visited. */
  readonly ran: boolean;
  readonly visited: number;
  /** The DIDs whose key this run published to PLC. */
  readonly published: ReadonlyArray<string>;
  /** The DIDs that only got a stored key the owner has to publish. */
  readonly unpublished: ReadonlyArray<string>;
  /** The DIDs that failed, and will be retried by the next run. */
  readonly failed: ReadonlyArray<string>;
}

/**
 * Publish the account's held key, when this host is allowed to.
 *
 * The conditions are the spec's: we are named in the account's rotation keys,
 * and the DID already points at us. Both are read from the directory rather than
 * assumed — an account that migrated away still lists a key we could sign with,
 * and rewriting its document from here would be signing for a host that is no
 * longer responsible for it.
 */
const publishKemKey = (params: {
  readonly plcUrl: string;
  readonly rotationKey: PrivateKey;
  readonly endpoint: string;
  readonly did: string;
  readonly kemKey: AccountKemKey;
}) =>
  Effect.gen(function* () {
    const host = yield* createDIDKey(params.rotationKey.publicKey);
    const state = yield* currentOperationData({
      plcUrl: params.plcUrl,
      did: params.did,
    });
    const head = yield* currentOperationCid({
      plcUrl: params.plcUrl,
      did: params.did,
    });
    if (Option.isNone(state) || Option.isNone(head)) {
      return false;
    }
    const data = state.value;
    if (
      data.services.atproto_pds.endpoint !== params.endpoint ||
      !data.rotationKeys.includes(host) ||
      // The account already publishes a KEM key. That is either this same key
      // (nothing to do) or one its owner published after rotating elsewhere, in
      // which case overwriting it would retract a key the account still holds.
      data.verificationMethods.atproto_kem !== undefined
    ) {
      return false;
    }
    const operation = buildOperation({
      alsoKnownAs: data.alsoKnownAs,
      serviceEndpoint: data.services.atproto_pds.endpoint,
      rotationKeys: data.rotationKeys,
      signingKey: data.verificationMethods.atproto,
      kemKey: params.kemKey.didKey,
      prev: head.value,
    });
    const signed = yield* signOperation({
      operation,
      privateKey: params.rotationKey,
    });
    yield* submitOperation({
      plcUrl: params.plcUrl,
      did: params.did,
      operation: signed,
    });
    return true;
  });

/** What the backfill needs: the accounts, who we are, and where events go. */
export interface KemBackfillDeps {
  readonly config: KemBackfillConfig;
  readonly accounts: AccountStore['Service'];
  /**
   * The stream an `#identity` event goes on when a key is published: a cached
   * DID document is stale the moment the operation lands, and the event is how a
   * syncer hears about it before its next MAC fails.
   */
  readonly firehose?: Firehose['Service'] | undefined;
  readonly now?: number | undefined;
}

/**
 * Give every account a KEM key, once.
 *
 * Runs over the whole account list — not only accounts with space repos, because
 * nothing here knows which those are, and a key that exists before the first
 * space is a key that does not have to be published while a syncer waits. It is
 * one-shot: completion is recorded, and an account that already has a key is
 * skipped, so a re-run after a crash is cheap.
 *
 * A failure is *not* recorded as completion: the accounts that failed keep their
 * stored key and are retried by the next run, which is the whole retry policy.
 *
 * ponytail: no lease, so two nodes booting at once both walk the list. Every
 * step is idempotent (the key write is conditional, the publication skips a DID
 * that already names a KEM key), so the cost is duplicate directory reads; add a
 * lease over the `KB/complete` row when a deployment runs more than one writer.
 */
export const backfillKemKeys = (deps: KemBackfillDeps) =>
  Effect.gen(function* () {
    const now = deps.now ?? Date.now();
    const complete = yield* deps.accounts.kemBackfillComplete;
    if (complete) {
      return {
        ran: false,
        visited: 0,
        published: [],
        unpublished: [],
        failed: [],
      };
    }

    const accounts = yield* deps.accounts.list;
    const plc = plcOf(deps.config);
    const endpoint = endpointOf(deps.config);

    const one = (account: Account) =>
      Effect.gen(function* () {
        // A deleted account has no repo to serve and no document worth
        // updating: its row is kept only to keep the DID from being reused.
        if (account.status === 'deleted') {
          return went(account, 'skipped');
        }
        const key = yield* ensureKemKey({
          accounts: deps.accounts,
          did: account.did,
          now,
        });
        // A `did:web` document is not in a directory: there is nowhere to
        // publish to, and the account's own document is its owner's to update.
        if (plc === undefined || !account.did.startsWith('did:plc:')) {
          return went(account, 'unpublished');
        }
        const published = yield* publishKemKey({
          plcUrl: plc.url,
          rotationKey: plc.key,
          endpoint,
          did: account.did,
          kemKey: key,
        });
        return went(account, published ? 'published' : 'unpublished');
      }).pipe(
        // One account that cannot be published is not the run's failure: it is
        // named in the report, keeps its stored key, and is retried next boot.
        Effect.catch((cause) =>
          Effect.as(
            Effect.logWarning(
              `kem key backfill could not publish ${account.did}: ${String(cause)}`,
            ),
            went(account, 'failed'),
          ),
        ),
      );

    const outcomes = yield* Effect.forEach(accounts, one);
    const picked = (kind: KemBackfillOutcome['outcome']) =>
      outcomes.filter((one) => one.outcome === kind);
    const published = picked('published');
    const unpublished = picked('unpublished').map((one) => one.did);
    const failed = picked('failed').map((one) => one.did);

    yield* Effect.forEach(unpublished, (did) =>
      Effect.logDebug(
        `cannot publish kem key, account must update its did doc: ${did}`,
      ),
    );
    // One `#identity` event per published key: the document changed, and a
    // syncer that cached it has to ask again.
    yield* Effect.forEach(published, (one) =>
      deps.firehose === undefined
        ? Effect.void
        : deps.firehose.emitIdentity({
            time: new Date(now).toISOString(),
            timeUs: now * 1000,
            did: one.did,
            handle: one.handle,
          }),
    );

    if (failed.length === 0) {
      yield* deps.accounts.markKemBackfillComplete(now);
      yield* Effect.logInfo('kem key backfill complete');
    } else {
      yield* Effect.logWarning(
        `kem key backfill left ${failed.length} account(s) for the next run`,
      );
    }

    return {
      ran: true,
      visited: outcomes.length,
      published: published.map((one) => one.did),
      unpublished,
      failed,
    };
  });
