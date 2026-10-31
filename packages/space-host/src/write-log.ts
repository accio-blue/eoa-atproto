import { ATURI, DID, NSID, TID } from '@eoa/core';
import { Context, Effect, Layer, Option, Ref, Schema, Semaphore } from 'effect';
import {
  Kv,
  ShardLease,
  absentCondition,
  putOp,
  versionCondition,
} from '@eoa/kv';
import { CidString } from './grant.js';
import type { Entry } from '@eoa/kv';

/**
 * The per-(space, account) write log - permission-primitive.md section 9.3,
 * mirroring `packages/specs/specs/space-host/space-write-log.qnt`.
 *
 * A space holds one repo per account (spaces alpha, 2026-10-29), so the log is
 * keyed by `SpaceRepoRef`. Each repo has an APPEND-ONLY oplog. It is the truth;
 * current state is a
 * DERIVED VIEW (`foldState`). Writes are compare-and-swap: a writer presents
 * the head it last saw and the append commits only if that still is the head.
 * Mismatch is `BadRecordSwapError` and the log is left untouched - the policy
 * is fail, never merge. Single-writer serialization comes from the host's
 * fencing epoch, behind the `WriteLock` seam (celld adapter lands separately).
 */

export const RecordKey = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9._:~-]{1,512}$/),
).pipe(Schema.brand('RecordKey'));
export type RecordKey = typeof RecordKey.Type;

export const RecordAction = Schema.Literals(['create', 'update', 'delete']);
export type RecordAction = typeof RecordAction.Type;

/**
 * Which repo a log row belongs to. A space holds ONE REPO PER ACCOUNT (spaces
 * alpha, 2026-10-29), and each is its own append-only log with its own head, so
 * `(space, did)` is the log's identity.
 */
export const SpaceRepoRef = Schema.Struct({ space: ATURI, did: DID });
export type SpaceRepoRef = typeof SpaceRepoRef.Type;

/** `space record op` (section 9.3). Signature verification is the caller's job. */
export const SpaceRecordOp = Schema.Struct({
  space: ATURI,
  collection: NSID,
  rkey: RecordKey,
  action: RecordAction,
  prevCid: Schema.optionalKey(CidString),
  cid: CidString,
  rev: TID,
  author: DID,
  signature: Schema.Uint8Array,
  /**
   * The record's DRISL bytes. The log is where a space repo lives, so current
   * state has to carry the bytes and not only a CID: `getRepo` re-encodes the
   * STAR archive from them, and a digest cannot be turned back into a record.
   * Absent on a delete.
   */
  value: Schema.optionalKey(Schema.Uint8Array),
});
export type SpaceRecordOp = typeof SpaceRecordOp.Type;

export const decodeSpaceRecordOp = Schema.decodeUnknownEffect(SpaceRecordOp, {
  onExcessProperty: 'error',
});

/**
 * `com.atproto.space.clearRecords` as the log sees it: ONE entry that empties
 * the repo, not one `delete` per record (spaces alpha, 2026-10-29).
 *
 * `data` is the state digest the repo holds afterwards - the empty repo's
 * digest - which is what the write notification a syncer receives reports. The
 * PDS clears its own oplog on a clear; this log keeps the clear as a single
 * appended entry instead, because the log IS the repo's truth here and the
 * previous head is the compare-and-swap base. Truncating it would erase that
 * base and make a concurrent writer indistinguishable from a fresh one.
 */
export const SpaceClearOp = Schema.Struct({
  space: ATURI,
  action: Schema.Literal('clear'),
  rev: TID,
  author: DID,
  signature: Schema.Uint8Array,
  data: Schema.Uint8Array,
});
export type SpaceClearOp = typeof SpaceClearOp.Type;

/** Everything the log can hold: a per-record op, or one bulk clear. */
export type SpaceOp = SpaceRecordOp | SpaceClearOp;

export const decodeSpaceOp = Schema.decodeUnknownEffect(
  Schema.Union([SpaceRecordOp, SpaceClearOp]),
  { onExcessProperty: 'error' },
);

/** The compare-and-swap failed: the write did not happen. Re-read and retry. */
export class BadRecordSwapError extends Schema.TaggedError<BadRecordSwapError>()(
  'BadRecordSwapError',
  {
    /** `head`: the log moved under the writer. `record`: the record's cid differs from `prevCid`. */
    scope: Schema.Literals(['head', 'record']),
    expected: Schema.NullOr(CidString),
    actual: Schema.NullOr(CidString),
  },
) {}

/** The writer's fencing epoch is no longer the host's current one. */
export class StaleEpochError extends Schema.TaggedError<StaleEpochError>()(
  'StaleEpochError',
  {
    space: ATURI,
    presented: Schema.Int,
    current: Schema.Int,
  },
) {}

export type RecordHead = {
  readonly cid: CidString;
  readonly rev: TID;
  readonly author: DID;
  /** The record's bytes, absent on a delete (which leaves nothing to encode). */
  readonly value: Uint8Array | undefined;
};
/** Current records, keyed `collection/rkey`. Always derived from the log. */
export type SpaceState = ReadonlyMap<string, RecordHead>;

export const recordPath = (op: Pick<SpaceRecordOp, 'collection' | 'rkey'>) =>
  `${op.collection}/${op.rkey}`;

export const headOf = (log: ReadonlyArray<SpaceOp>): CidString | null => {
  const last = log.at(-1);
  // A clear leaves an EMPTY repo, which has no head record: the next write is a
  // `create` from `null`, exactly as on a repo that never held anything.
  return last === undefined || last.action === 'clear' ? null : last.cid;
};

export const foldState = (log: ReadonlyArray<SpaceOp>): SpaceState => {
  const state = new Map<string, RecordHead>();
  for (const op of log) {
    if (op.action === 'clear') {
      state.clear();
    } else if (op.action === 'delete') {
      state.delete(recordPath(op));
    } else {
      state.set(recordPath(op), {
        cid: op.cid,
        rev: op.rev,
        author: op.author,
        value: op.value,
      });
    }
  }
  return state;
};

/**
 * The pure CAS decision: `undefined` means the append may commit.
 * Checks the log head against `base`, then the record against `op.prevCid`
 * (absent for a create; the current cid for an update or delete). A clear has
 * no record to compare: it only has to be appended on the head the caller saw.
 */
export const checkSwap = (
  log: ReadonlyArray<SpaceOp>,
  op: SpaceOp,
  base: CidString | null,
): BadRecordSwapError | undefined => {
  const head = headOf(log);
  if (head !== base) {
    return new BadRecordSwapError({
      scope: 'head',
      expected: base,
      actual: head,
    });
  }
  if (op.action === 'clear') {
    return undefined;
  }
  const current = foldState(log).get(recordPath(op))?.cid ?? null;
  const expected = op.prevCid ?? null;
  const consistent =
    op.action === 'create'
      ? current === null && expected === null
      : current !== null && expected === current;
  return consistent
    ? undefined
    : new BadRecordSwapError({ scope: 'record', expected, actual: current });
};

/**
 * The batch decision: the head is compared ONCE, then every op against the
 * state the ops before it leave behind. That is what makes `applyWrites`
 * all-or-nothing: a batch with one bad op has a conflict before anything is
 * committed, and no prefix of it can land.
 */
export const checkBatch = (
  log: ReadonlyArray<SpaceOp>,
  ops: ReadonlyArray<SpaceOp>,
  base: CidString | null,
) => {
  const head = headOf(log);
  if (head !== base) {
    return new BadRecordSwapError({
      scope: 'head',
      expected: base,
      actual: head,
    });
  }
  const working = [...log];
  for (const op of ops) {
    if (op.action !== 'clear') {
      const current = foldState(working).get(recordPath(op))?.cid ?? null;
      const expected = op.prevCid ?? null;
      const consistent =
        op.action === 'create'
          ? current === null && expected === null
          : current !== null && expected === current;
      if (!consistent) {
        return new BadRecordSwapError({
          scope: 'record',
          expected,
          actual: current,
        });
      }
    }
    working.push(op);
  }
  return undefined;
};

export type FencingEpoch = number;

/**
 * The single-writer / fencing seam. The celld adapter implements this with a
 * conditional write plus the host's fencing epoch; a stale writer's epoch is
 * rejected, so it cannot win.
 */
export class WriteLock extends Context.Service<
  WriteLock,
  {
    /** Become the writer for `space`: a new epoch that supersedes older holders. */
    readonly acquire: (space: ATURI) => Effect.Effect<FencingEpoch>;
    /** Run `effect` exclusively, only if `epoch` is still the current one. */
    readonly withEpoch: <A, E, R>(
      space: ATURI,
      epoch: FencingEpoch,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StaleEpochError, R>;
  }
>()('@eoa/space-host/WriteLock') {
  // ponytail: one process-wide permit; per-space locks if contention matters.
  static readonly layerInMemory = Layer.effect(
    WriteLock,
    Effect.sync(() => makeWriteLock()),
  );
}

/** The in-memory fence, synchronous so a host can hold one without a layer. */
export const makeWriteLock = () => {
  const epochs = Ref.makeUnsafe<ReadonlyMap<ATURI, FencingEpoch>>(new Map());
  const permit = Semaphore.makeUnsafe(1);
  return WriteLock.of({
    acquire: (space) =>
      Ref.modify(epochs, (all) => {
        const next = (all.get(space) ?? 0) + 1;
        return [next, new Map(all).set(space, next)] as const;
      }),
    withEpoch: (space, epoch, effect) =>
      Semaphore.withPermit(
        permit,
        Effect.gen(function* () {
          const current = (yield* Ref.get(epochs)).get(space) ?? 0;
          if (current !== epoch) {
            return yield* new StaleEpochError({
              space,
              presented: epoch,
              current,
            });
          }
          return yield* effect;
        }),
      ),
  });
};

export interface WriteCommit {
  /** The head cid the writer last saw (`null` for an empty log). */
  readonly base: CidString | null;
  readonly epoch: FencingEpoch;
}

/**
 * The oplog. There is deliberately no update/delete method: the log only grows.
 * Backends other than the in-memory one implement this same interface and can
 * reuse `checkSwap` / `foldState`.
 */
/**
 * One repo as a listing reports it: what the **write log** knows, which is the present.
 *
 * The archive's `writers` section is not this — it is what an import arrived with (see
 * `SpaceMetaArchive.writers`). A repo appears here when it has taken its first write.
 */
export interface SpaceRepoEntry {
  readonly did: string;
  /** The last revision the repo reached, or `null` before its first write. */
  readonly rev: string | null;
  /** The commit the log ends at; `null` for a repo whose log is empty or was cleared. */
  readonly head: CidString | null;
}

export class SpaceWriteLog extends Context.Service<
  SpaceWriteLog,
  {
    /**
     * Commit one op iff the fence and the CAS hold; returns its 1-based
     * position. `repo` is the `(space, did)` log the op belongs to.
     */
    readonly append: (
      repo: SpaceRepoRef,
      op: SpaceOp,
      commit: WriteCommit,
    ) => Effect.Effect<number, BadRecordSwapError | StaleEpochError>;
    /**
     * Commit several record ops as ONE step: either every op lands or none
     * does. This is what `applyWrites` promises (`applyWrites` is one commit).
     */
    readonly appendBatch: (
      repo: SpaceRepoRef,
      ops: ReadonlyArray<SpaceRecordOp>,
      commit: WriteCommit,
    ) => Effect.Effect<number, BadRecordSwapError | StaleEpochError>;
    /** The bulk clear: one entry, an empty repo, the same CAS and fence as an append. */
    readonly clear: (
      repo: SpaceRepoRef,
      op: SpaceClearOp,
      commit: WriteCommit,
    ) => Effect.Effect<number, BadRecordSwapError | StaleEpochError>;
    readonly entries: (
      repo: SpaceRepoRef,
    ) => Effect.Effect<ReadonlyArray<SpaceOp>>;
    readonly head: (repo: SpaceRepoRef) => Effect.Effect<CidString | null>;
    /** The derived view: a fold over the log. */
    readonly state: (repo: SpaceRepoRef) => Effect.Effect<SpaceState>;
    /**
     * Every repo that has taken a write in `space` — the present writer set, which is what
     * `com.atproto.space.listRepos` answers with.
     */
    readonly repos: (
      space: ATURI,
    ) => Effect.Effect<ReadonlyArray<SpaceRepoEntry>>;
  }
>()('@eoa/space-host/SpaceWriteLog') {
  static readonly layerInMemory = Layer.effect(
    SpaceWriteLog,
    Effect.gen(function* () {
      const fence = yield* WriteLock;
      return makeSpaceLog(fence);
    }),
  );
}

/**
 * An in-memory log and its fence, sharing one epoch map. The PDS uses this when
 * it is not given a durable log; tests use it through the layer.
 */
export const memorySpaceWriteLog = () => {
  const lock = makeWriteLock();
  return { lock, log: makeSpaceLog(lock) };
};

const repoKey = (repo: SpaceRepoRef) => `${repo.space}|${repo.did}`;

/** What a listing says about one repo: its last revision and where its log ends. */
const entryOf = (
  did: string,
  entries: ReadonlyArray<SpaceOp>,
): SpaceRepoEntry => {
  const last = entries.at(-1);
  return {
    did,
    rev: last === undefined ? null : String(last.rev),
    head: headOf(entries),
  };
};

// ponytail: refolds the log per append (O(n)); keep an incremental state if logs get long.
const makeSpaceLog = (fence: WriteLock['Service']) => {
  const logs = Ref.makeUnsafe<ReadonlyMap<string, ReadonlyArray<SpaceOp>>>(
    new Map(),
  );
  const entries = (repo: SpaceRepoRef) =>
    Ref.get(logs).pipe(Effect.map((all) => all.get(repoKey(repo)) ?? []));

  const commitOps = (
    repo: SpaceRepoRef,
    ops: ReadonlyArray<SpaceOp>,
    commit: WriteCommit,
  ) =>
    fence.withEpoch(
      repo.space,
      commit.epoch,
      Effect.gen(function* () {
        const log = yield* entries(repo);
        const conflict = checkBatch(log, ops, commit.base);
        if (conflict !== undefined) {
          return yield* conflict;
        }
        const next = [...log, ...ops];
        yield* Ref.update(logs, (all) => new Map(all).set(repoKey(repo), next));
        return next.length;
      }),
    );

  return SpaceWriteLog.of({
    append: (repo, op, commit) => commitOps(repo, [op], commit),
    appendBatch: (repo, ops, commit) => commitOps(repo, ops, commit),
    clear: (repo, op, commit) => commitOps(repo, [op], commit),
    entries,
    head: (repo) => entries(repo).pipe(Effect.map(headOf)),
    state: (repo) => entries(repo).pipe(Effect.map(foldState)),
    repos: (space) =>
      Ref.get(logs).pipe(
        Effect.map((all) =>
          [...all]
            .flatMap(([key, ops]) => {
              const split = key.indexOf('|');
              if (split === -1 || key.slice(0, split) !== space) {
                return [];
              }
              return [entryOf(key.slice(split + 1), ops)];
            })
            .sort((left, right) =>
              left.did < right.did ? -1 : left.did > right.did ? 1 : 0,
            ),
        ),
      ),
  });
};

/**
 * The durable log: rows in `Kv`, serialization from `ShardLease`.
 *
 * A space holds one repo per account, so every row is under BOTH ids. Row
 * layout, under a prefix no other store uses (`SP/`, `SPA/`, `SPH/`, `R/`,
 * `B/`, ... are taken):
 *
 * - `SWL/{space}/{did}/head` - the compare-and-swap point. Holds the head cid
 *   (or `null` for an empty log, which is also what a `clear` leaves behind)
 *   and, as the row's KV version, the token every append conditions on.
 * - `SWL/{space}/{did}/op/{position}` - one entry per commit, the op as JSON.
 *
 * Both a space URI and a DID are percent-encoded with `encodeURIComponent`.
 * That escapes `/` (and `%`, so decoding is unique and the mapping injective),
 * which keeps each id inside ONE path segment: no repo's keys are a prefix of
 * another repo's past a segment boundary, and `SWL/` cannot be confused with
 * any `S...`/`SP...` store's rows. Positions are zero-padded to 12 digits
 * because `Kv` orders keys lexicographically and the log must read back in
 * commit order.
 *
 * Values are the op as JSON: `Schema`'s default JSON encoding writes the
 * `signature`/`data`/`value` `Uint8Array`s as base64, so a row is portable
 * text.
 *
 * `SpaceWriteLog` has no error type for the store, so a `Kv` or object-store
 * failure here is a defect: a record that does not decode, a lease that cannot
 * be read, or a bucket that is down are not "retry the write", they are a host
 * that should stop and be looked at. The two *expected* refusals stay typed.
 */
const PAGE_LIMIT = 10_000;

const repoRow = (repo: SpaceRepoRef) =>
  `SWL/${encodeURIComponent(repo.space)}/${encodeURIComponent(repo.did)}`;

const headKey = (repo: SpaceRepoRef) => `${repoRow(repo)}/head`;

const opPrefix = (repo: SpaceRepoRef) => `${repoRow(repo)}/op/`;

const opKey = (repo: SpaceRepoRef, position: number) =>
  `${opPrefix(repo)}${String(position).padStart(12, '0')}`;

const OpJson = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Union([SpaceRecordOp, SpaceClearOp])),
);

const HeadJson = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Struct({ head: Schema.NullOr(CidString) })),
);

const decodeOpRow = Schema.decodeUnknownSync(OpJson);
const encodeOpRow = Schema.encodeSync(OpJson);
const decodeHeadRow = Schema.decodeUnknownSync(HeadJson);
const encodeHeadRow = Schema.encodeSync(HeadJson);

const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The durable log: one `Kv`, one fence.
 *
 * `lock` is a `WriteLock` rather than a `ShardLease` because a deployment may have either — a host with
 * a store but no lease still keeps its rows, and fences per process. `writeLockOverLease` is the pair
 * for a host that has both (`m93v`).
 */
export const spaceWriteLogOverKv = (params: {
  readonly kv: Kv['Service'];
  readonly lock: WriteLock['Service'];
}): SpaceWriteLog['Service'] => {
  const kv = params.kv;
  const lock = params.lock;

  /** Every row under `prefix`, following the scan cursor to the end. */
  const rows = (prefix: string) =>
    Effect.gen(function* () {
      const found: Array<Entry> = [];
      let cursor: string | undefined;
      do {
        const page = yield* kv.scan(
          cursor === undefined
            ? { prefix, limit: PAGE_LIMIT }
            : { prefix, limit: PAGE_LIMIT, cursor },
        );
        found.push(...page.entries);
        cursor = page.cursor;
      } while (cursor !== undefined);
      return found;
    });

  const heldHead = (repo: SpaceRepoRef) =>
    kv.get(headKey(repo)).pipe(
      Effect.orDie,
      Effect.map(
        Option.map((entry) => ({
          head: decodeHeadRow(textOf(entry.value)).head,
          version: entry.version,
        })),
      ),
    );

  const readEntries = (repo: SpaceRepoRef) =>
    rows(opPrefix(repo)).pipe(
      Effect.orDie,
      Effect.flatMap((found) =>
        Effect.forEach(found, (entry) =>
          Effect.sync(() => decodeOpRow(textOf(entry.value))),
        ),
      ),
    );

  /**
   * One atomic batch per write: the op rows plus the head row, the head row
   * conditioned on the version read above.
   *
   * Two refusals, deliberately different:
   *
   * - `StaleEpochError` - the fence said this writer has been superseded.
   *   STOP: re-acquiring the lease is the only way back; retrying the same
   *   epoch will never succeed.
   * - `BadRecordSwapError` - the head moved since it was observed. RETRY:
   *   re-read the head (and the record) and try again on the new base.
   *
   * The fence is checked first, so a stale host fails here rather than
   * discovering it after a successful CAS - the case the in-memory epoch
   * `Ref` cannot see across processes.
   *
   * ponytail: the fence and the batch are two stores, so a takeover that
   * lands between them can still let one write through. Closing that needs
   * the epoch in the same `Kv` batch (a lease row), not a separate object.
   */
  const commitOps = (
    repo: SpaceRepoRef,
    ops: ReadonlyArray<SpaceOp>,
    commit: WriteCommit,
  ) =>
    // The fence wraps the whole commit, so a superseded writer fails before it reads anything — the
    // case a per-process epoch cannot see across hosts.
    lock.withEpoch(
      repo.space,
      commit.epoch,
      Effect.gen(function* () {
        // The head row is read FIRST: its version is the CAS token, so any
        // commit after this read bumps the version and the batch below is
        // refused. A commit between this read and the batch is therefore not
        // a lost update, and the entries read below are only trusted because
        // the batch re-checks that version atomically.
        const stored = yield* heldHead(repo);
        const log = yield* readEntries(repo);

        // The model's rule, for the precise error the caller sees and for the
        // record-level `prevCid` check a single head row cannot express.
        const conflict = checkBatch(log, ops, commit.base);
        if (conflict !== undefined) {
          return yield* conflict;
        }

        const position = log.length + 1;
        const last = ops.at(-1);
        const next =
          last === undefined || last.action === 'clear' ? null : last.cid;
        const value = bytesOf(encodeHeadRow({ head: next }));
        const head = Option.isSome(stored)
          ? putOp({
              key: headKey(repo),
              value,
              condition: versionCondition({ version: stored.value.version }),
            })
          : putOp({
              key: headKey(repo),
              value,
              condition: absentCondition(),
            });

        yield* kv
          .batch([
            ...ops.map((op, index) =>
              putOp({
                key: opKey(repo, position + index),
                value: bytesOf(encodeOpRow(op)),
              }),
            ),
            head,
          ])
          .pipe(
            // The head row is the only conditioned row in the batch, so a
            // precondition failure is always the lost swap.
            Effect.catchTag('KeyPreconditionFailed', () =>
              heldHead(repo).pipe(
                Effect.orDie,
                Effect.flatMap((now) =>
                  Effect.fail(
                    new BadRecordSwapError({
                      scope: 'head',
                      expected: commit.base,
                      actual: Option.isSome(now) ? now.value.head : null,
                    }),
                  ),
                ),
              ),
            ),
            Effect.catchTags({
              CursorInvalid: (error) => Effect.die(error),
              KvUnavailable: (error) => Effect.die(error),
              SnapshotExpired: (error) => Effect.die(error),
            }),
          );

        return position + ops.length - 1;
      }),
    );

  return SpaceWriteLog.of({
    append: (repo, op, commit) => commitOps(repo, [op], commit),
    appendBatch: (repo, ops, commit) => commitOps(repo, ops, commit),
    clear: (repo, op, commit) => commitOps(repo, [op], commit),
    entries: readEntries,
    head: (repo) =>
      heldHead(repo).pipe(
        Effect.map(
          Option.match({ onNone: () => null, onSome: (row) => row.head }),
        ),
      ),
    state: (repo) => readEntries(repo).pipe(Effect.map(foldState)),
    repos: (space) =>
      Effect.gen(function* () {
        const prefix = `SWL/${encodeURIComponent(space)}/`;
        const found = yield* rows(prefix);
        // Every repo's rows share the prefix, and only the head row names its repo: one per repo,
        // which is also the row that exists before any op does.
        const dids = found.flatMap((entry) => {
          const rest = entry.key.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash <= 0 || rest.slice(slash + 1) !== 'head') {
            return [];
          }
          return [decodeURIComponent(rest.slice(0, slash))];
        });
        const listed = yield* Effect.forEach([...dids].sort(), (did) =>
          readEntries({
            space,
            did: Schema.decodeSync(DID)(did),
          }).pipe(Effect.map((entries) => entryOf(did, entries))),
        );
        return listed;
      }).pipe(Effect.orDie),
  });
};

/** The durable log as a layer: a `Kv` and whichever fence the deployment has. */
export const spaceWriteLogKvLayer: Layer.Layer<
  SpaceWriteLog,
  never,
  Kv | WriteLock
> = Layer.effect(
  SpaceWriteLog,
  Effect.gen(function* () {
    return spaceWriteLogOverKv({ kv: yield* Kv, lock: yield* WriteLock });
  }),
);

/**
 * The fence as a stored lease: `withEpoch` asks the lease whether this host is still the writer, so the
 * refusal survives a restart and covers two hosts. `acquire` takes the shard for `owner`.
 *
 * ponytail: contention dies rather than retrying — `WriteLock.acquire` has no error channel, and a
 * host that cannot take its shard at startup is a deployment that should say so loudly.
 */
export const writeLockOverLease = (
  owner: string,
): Layer.Layer<WriteLock, never, ShardLease> =>
  Layer.effect(
    WriteLock,
    Effect.gen(function* () {
      const lease = yield* ShardLease;
      return WriteLock.of({
        acquire: (space) =>
          lease.acquire(space, owner).pipe(
            Effect.map((held) => held.epoch),
            Effect.catchTags({
              LeaseLost: (error) => Effect.die(error),
              LeaseContended: (error) => Effect.die(error),
              PreconditionFailed: (error) => Effect.die(error),
              ObjectStoreUnavailable: (error) => Effect.die(error),
            }),
          ),
        withEpoch: (space, epoch, effect) =>
          lease.fence(space, epoch).pipe(
            Effect.catchTag('LeaseLost', () =>
              lease.read(space).pipe(
                Effect.orDie,
                Effect.flatMap((held) =>
                  Effect.fail(
                    new StaleEpochError({
                      space,
                      presented: epoch,
                      current: Option.isSome(held) ? held.value.epoch : 0,
                    }),
                  ),
                ),
              ),
            ),
            Effect.catchTags({
              PreconditionFailed: (error) => Effect.die(error),
              ObjectStoreUnavailable: (error) => Effect.die(error),
            }),
            Effect.andThen(effect),
          ),
      });
    }),
  );
