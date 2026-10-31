import {
  type Account,
  type AccountStore,
  type AppPassword,
  type Session,
} from './account-store.js';
import { type BlobStore, type StoredBlob } from './blob-store.js';
import { Effect, Option } from 'effect';
import { type Head, type RepoStore } from '@eoa/repo-store';

/**
 * The operator's view of this PDS (the Effect-PDS map, `acz5`).
 *
 * A CLI, and no HTTP: an operator who can read the store already has the access
 * this needs, and a remote admin surface is a decision of its own — with its own
 * authentication, its own audit trail and its own way to be wrong. What is here
 * is the *reading*: the same rows the server reads, asked directly.
 *
 * Every query returns data rather than printing it, so the CLI is a thin shell
 * over this and a test can ask the same questions without a terminal.
 */

/** The stores this PDS holds its world in. */
export interface OperatorDeps {
  readonly accounts: AccountStore['Service'];
  readonly repo: RepoStore['Service'];
  readonly blobs: BlobStore['Service'];
}

/** One account, with what it holds. */
export interface AccountReport {
  readonly account: Account;
  readonly sessions: ReadonlyArray<Session>;
  readonly appPasswords: ReadonlyArray<AppPassword>;
}

/** One repo, as an operator asks about it. */
export interface RepoReport {
  readonly did: string;
  readonly head: Head;
  /** The collections the repo holds, in order. */
  readonly collections: ReadonlyArray<string>;
  readonly records: number;
}

/** The DID a name refers to, by handle or by DID. */
const didOf = (deps: OperatorDeps, asked: string) =>
  asked.startsWith('did:')
    ? Effect.succeedSome(asked)
    : deps.accounts
        .byHandle(asked.toLowerCase())
        .pipe(Effect.map(Option.map((found) => found.did)));

/** Every account, in handle order — the first thing an operator asks. */
export const accountsOf = (deps: OperatorDeps) =>
  deps.accounts.list.pipe(
    Effect.map((all) =>
      [...all].sort((left, right) => (left.handle < right.handle ? -1 : 1)),
    ),
  );

/** One account, and what it is holding. */
export const accountOf = (deps: OperatorDeps, asked: string) =>
  Effect.gen(function* () {
    const did = yield* didOf(deps, asked);
    if (Option.isNone(did)) {
      return Option.none<AccountReport>();
    }
    const account = yield* deps.accounts.account(did.value);
    if (Option.isNone(account)) {
      return Option.none<AccountReport>();
    }
    return Option.some({
      account: account.value,
      sessions: yield* deps.accounts.sessions(did.value),
      appPasswords: yield* deps.accounts.appPasswords(did.value),
    });
  });

/** One repo: its head, what it holds, and how much of it there is. */
export const repoOf = (deps: OperatorDeps, asked: string) =>
  Effect.gen(function* () {
    const did = yield* didOf(deps, asked);
    if (Option.isNone(did)) {
      return Option.none<RepoReport>();
    }
    const head = yield* deps.repo.head(did.value);
    if (Option.isNone(head)) {
      return Option.none<RepoReport>();
    }
    const records = yield* deps.repo.leaves(did.value, '', '\uffff');
    return Option.some({
      did: did.value,
      head: head.value,
      collections: [
        ...new Set(records.map((one) => one.key.split('/')[0] ?? '')),
      ]
        .filter((one) => one.length > 0)
        .sort(),
      records: records.length,
    });
  });

/** The blobs a repo owns, in CID order. */
export const blobsOf = (deps: OperatorDeps, asked: string) =>
  Effect.gen(function* () {
    const did = yield* didOf(deps, asked);
    if (Option.isNone(did)) {
      return Option.none<ReadonlyArray<StoredBlob>>();
    }
    const blobs = yield* deps.blobs.list(did.value);
    return Option.some(
      [...blobs].sort((left, right) => (left.cid < right.cid ? -1 : 1)),
    );
  });
