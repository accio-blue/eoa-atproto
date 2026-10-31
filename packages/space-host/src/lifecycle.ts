import { ATURI, DID, TID } from '@eoa/core';
import {
  type BadRecordSwapError,
  type FencingEpoch,
  type SpaceClearOp,
  SpaceWriteLog,
  type StaleEpochError,
  type WriteCommit,
  WriteLock,
} from './write-log.js';
import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { type CryptoError } from '@eoa/crypto';
import { ltHashDigestOf } from './lthash.js';

/**
 * The two policy-agnostic lifecycle methods of the 2026-10-29 spaces alpha:
 * `com.atproto.space.clearRecords` (proposal#127) and
 * `com.atproto.space.removeWriter` (proposal#128).
 *
 * Both are about the sync boundary rather than about grants: clearing empties a
 * repo, removing a writer prunes the authority's claim about which repos hold
 * data. Neither changes what the protocol authorizes - `clearRecords` requires a
 * delete grant per collection and `removeWriter` requires `manage=update`, and
 * both checks belong to the auth layer above this package.
 */

/** One repo in a space's writer set, as `com.atproto.space.listRepos` reports it. */
export const WriterEntry = Schema.Struct({
  space: ATURI,
  did: DID,
  rev: TID,
  /** The repo commit's `data`: the digest of its current record set. */
  data: Schema.Uint8Array,
});
export type WriterEntry = typeof WriterEntry.Type;

/**
 * The authority's claim about which repos hold data in a space. It is not
 * authoritative for any one repo (the repo host is), which is why dropping an
 * entry is a prune and not a revocation: the next authorized write re-adds it.
 */
export class WriterSet extends Context.Service<
  WriterSet,
  {
    readonly list: (space: ATURI) => Effect.Effect<ReadonlyArray<WriterEntry>>;
    /** Record (or refresh) one repo; the writer set holds one entry per DID. */
    readonly track: (entry: WriterEntry) => Effect.Effect<void>;
    /** Drop `did`; `true` when it was listed. Idempotent: a second drop is a no-op. */
    readonly drop: (input: {
      readonly space: ATURI;
      readonly did: DID;
    }) => Effect.Effect<boolean>;
  }
>()('@eoa/space-host/WriterSet') {
  static readonly layerInMemory = Layer.effect(
    WriterSet,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<WriterEntry>>([]);
      return WriterSet.of({
        list: (space) =>
          Ref.get(entries).pipe(
            Effect.map((all) => all.filter((entry) => entry.space === space)),
          ),
        track: (entry) =>
          Ref.update(entries, (all) => [
            ...all.filter(
              (known) => known.space !== entry.space || known.did !== entry.did,
            ),
            entry,
          ]),
        drop: ({ space, did }) =>
          Ref.modify(entries, (all) => {
            const kept = all.filter(
              (entry) => entry.space !== space || entry.did !== did,
            );
            return [kept.length !== all.length, kept] as const;
          }),
      });
    }),
  );
}

/**
 * `com.atproto.space.removeWriter`: prune one account from the space's writer
 * set. The protocol says the account is tracked again if it later writes while
 * still authorized, so this does NOT touch grants or membership - revoking
 * access is a separate act.
 *
 * The fencing question (the same one bean m93v answers for writes): a write that
 * was already in flight when the prune ran must not resurrect the entry it
 * removed. Both operations run under the space's fencing epoch, so a write
 * holding an older epoch fails with `StaleEpochError` and cannot re-add; a write
 * that acquires a fresh epoch afterwards is authorized and does re-add, which is
 * exactly the protocol's "tracked again if it later writes". The caller acquires
 * the epoch first (`WriteLock.acquire`), which supersedes in-flight writers.
 */
export const removeWriter = Effect.fn('removeWriter')(function* (input: {
  readonly space: ATURI;
  readonly did: DID;
  readonly epoch: FencingEpoch;
}): Effect.fn.Return<boolean, StaleEpochError, WriteLock | WriterSet> {
  const fence = yield* WriteLock;
  const writers = yield* WriterSet;
  return yield* fence.withEpoch(
    input.space,
    input.epoch,
    writers.drop({ space: input.space, did: input.did }),
  );
});

/**
 * `com.atproto.space.clearRecords`: empty one repo in ONE operation.
 *
 * What a syncer sees: one write notification, carrying the new `rev` and the
 * empty repo's digest - not one delete per record. It then pulls the repo and
 * finds it empty, and the repo STAYS in the writer set (`listRepos`) at that
 * digest, because an empty repo and a missing repo are not distinguished on the
 * wire (proposal#127; the host may garbage-collect it later).
 *
 * What the write log sees: one `clear` entry (see `SpaceClearOp`), appended
 * under the same head CAS and fencing epoch as a record op. Current state is
 * empty and `head` is `null`, so the next write is a `create` from `null`.
 *
 * The digest is computed by our own LtHash (`lthash.ts`), so it is NOT the
 * `e5a00aa9...` digest atproto publishes: that one is their BLAKE3-XOF LtHash,
 * and hardcoding it here would claim a commitment our archive never makes.
 */
export const clearRecords = Effect.fn('clearRecords')(function* (input: {
  readonly space: ATURI;
  /** The account whose repo in the space is cleared. */
  readonly did: DID;
  readonly rev: TID;
  readonly author: DID;
  readonly signature: Uint8Array;
  readonly commit: WriteCommit;
}): Effect.fn.Return<
  number,
  BadRecordSwapError | StaleEpochError | CryptoError,
  SpaceWriteLog
> {
  const log = yield* SpaceWriteLog;
  const data = yield* ltHashDigestOf([]);
  const op: SpaceClearOp = {
    space: input.space,
    action: 'clear',
    rev: input.rev,
    author: input.author,
    signature: input.signature,
    data,
  };
  return yield* log.clear(
    { space: input.space, did: input.did },
    op,
    input.commit,
  );
});
