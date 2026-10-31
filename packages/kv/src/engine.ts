import type {
  ConditionMap,
  Key,
  KvError,
  OpMap,
  ScanOptions,
  Sequence,
  Value,
} from './types.js';
import {
  Context,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  type Scope,
} from 'effect';
import { CursorInvalid, KeyPreconditionFailed } from './types.js';

/** How many entries a scan returns when the caller does not say. */
export const DEFAULT_LIMIT = 1000;

/** One write to a key; `value: undefined` is a tombstone. */
export interface Versioned {
  readonly version: Sequence;
  readonly value: Value | undefined;
}

/** A key's versions, oldest first. Never compacted — see the ponytail note. */
export type Log = ReadonlyMap<Key, ReadonlyArray<Versioned>>;

export interface State {
  readonly sequence: Sequence;
  readonly log: Log;
}

export const EMPTY: State = { sequence: 0, log: new Map() };

/** What committing a batch produced: the new state, or the refusal. */
export type CommitMap = Data.TaggedEnum<{
  readonly committed: { readonly state: State };
  readonly rejected: { readonly error: KvError };
}>;

export const { committed: committedCommit, rejected: rejectedCommit } =
  Data.taggedEnum<CommitMap>();

/** What a reader at `at` sees for `key`, or `none` when it is absent there. */
export const valueAt = (log: Log, key: Key, at: Sequence) => {
  const found = (log.get(key) ?? [])
    .filter((entry) => entry.version <= at)
    .at(-1);
  return found === undefined || found.value === undefined
    ? Option.none<{ readonly version: Sequence; readonly value: Value }>()
    : Option.some({ version: found.version, value: found.value });
};

/** Whether a write's precondition holds against the log's newest state. */
export const conditionHolds = (log: Log, key: Key, condition: ConditionMap) => {
  const newest = log.get(key)?.at(-1);
  const live =
    newest === undefined || newest.value === undefined
      ? Option.none<Sequence>()
      : Option.some(newest.version);
  return Match.value(condition).pipe(
    Match.tag('absent', () => Option.isNone(live)),
    Match.tag(
      'version',
      ({ version }) => Option.isSome(live) && live.value === version,
    ),
    Match.exhaustive,
  );
};

/** Pure: the whole batch lands at one sequence, or the state is untouched. */
export const commitTo = (state: State, ops: ReadonlyArray<OpMap>) => {
  for (const op of ops) {
    const condition = op.condition;
    if (
      condition !== undefined &&
      !conditionHolds(state.log, op.key, condition)
    ) {
      return rejectedCommit({
        error: new KeyPreconditionFailed({
          key: op.key,
          expected: condition._tag,
        }),
      });
    }
  }

  // ponytail: the log map is copied per commit and its versions are never
  // compacted — a persistent structure and a GC arrive with the LSM backend.
  const version = state.sequence + 1;
  const log = ops.reduce<Log>(
    (acc, op) =>
      new Map(acc).set(op.key, [
        ...(acc.get(op.key) ?? []),
        {
          version,
          value: Match.value(op).pipe(
            Match.tag('put', (write) => write.value),
            Match.orElse(() => undefined),
          ),
        },
      ]),
    state.log,
  );
  return committedCommit({ state: { sequence: version, log } });
};

/** Every live entry at `at`, in key order. */
export const entriesAt = (log: Log, at: Sequence) =>
  [...log.keys()].sort().flatMap((key) =>
    Option.toArray(valueAt(log, key, at)).map((found) => ({
      key,
      value: found.value,
      version: found.version,
    })),
  );

export interface Cursor {
  readonly at: Sequence;
  readonly key: Key;
}

/** Opaque to callers: the snapshot, then the last key handed out. */
export const encodeCursor = (cursor: Cursor) =>
  `${cursor.at}\u0000${cursor.key}`;

export const decodeCursor = (cursor: string) => {
  const cut = cursor.indexOf('\u0000');
  if (cut < 1) {
    return Option.none<Cursor>();
  }
  const at = Number(cursor.slice(0, cut));
  return Number.isInteger(at) && at >= 0
    ? Option.some({ at, key: cursor.slice(cut + 1) })
    : Option.none<Cursor>();
};

/**
 * The whole scan — cursor, snapshot, filtering and paging — over a state.
 * Every backend owes the same answer, so it lives here once.
 */
export const scanState = (state: State, options: ScanOptions | undefined) => {
  const requested = options?.cursor;
  const decoded =
    requested === undefined ? Option.none<Cursor>() : decodeCursor(requested);
  if (requested !== undefined && Option.isNone(decoded)) {
    return Effect.fail(new CursorInvalid({ cursor: requested }));
  }

  const asked = options?.at;
  const at = Option.isSome(decoded)
    ? decoded.value.at
    : (asked ?? state.sequence);
  if (asked !== undefined && asked !== at) {
    return Effect.fail(new CursorInvalid({ cursor: requested ?? '' }));
  }

  const prefix = options?.prefix ?? '';
  const start = options?.start ?? prefix;
  const end = options?.end;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const after = Option.isSome(decoded) ? decoded.value.key : undefined;

  const matching = entriesAt(state.log, at).filter(
    (entry) =>
      entry.key.startsWith(prefix) &&
      entry.key >= start &&
      (end === undefined || entry.key < end) &&
      (after === undefined || entry.key > after),
  );
  const page = matching.slice(0, limit);
  const last = page.at(-1);
  const cursor =
    matching.length > page.length && last !== undefined
      ? encodeCursor({ at, key: last.key })
      : undefined;

  return Effect.succeed(
    cursor === undefined
      ? { at, entries: page }
      : { at, entries: page, cursor },
  );
};

/**
 * The snapshots readers hold, and the watermark they set.
 *
 * A reader takes a snapshot at the sequence it wants; until it lets go, nothing
 * below that sequence may be dropped. With nothing held the watermark is the
 * current sequence — history is not kept for free, so a read at a past sequence
 * has to be paid for by holding one (`SnapshotExpired` otherwise).
 */
export interface HoldsShape {
  /** Hold a snapshot at `at` for as long as the enclosing scope lives. */
  readonly snapshot: (
    at: Sequence,
  ) => Effect.Effect<Sequence, never, Scope.Scope>;
  /** The oldest sequence anything holds, or `current` when nothing is held. */
  readonly watermark: (current: Sequence) => Effect.Effect<Sequence>;
  /** How many snapshots readers hold right now. */
  readonly held: Effect.Effect<number>;
}

export class Holds extends Context.Service<Holds, HoldsShape>()(
  '@eoa/kv/Holds',
) {}

export const holdsLayer = Layer.effect(
  Holds,
  Effect.gen(function* () {
    const held = yield* Ref.make(new Map<Sequence, number>());

    return Holds.of({
      snapshot: (at) =>
        Effect.acquireRelease(
          Ref.update(held, (open) =>
            new Map(open).set(at, (open.get(at) ?? 0) + 1),
          ).pipe(Effect.as(at)),
          (taken) =>
            Ref.update(held, (open) => {
              const next = new Map(open);
              const left = (next.get(taken) ?? 0) - 1;
              if (left <= 0) {
                next.delete(taken);
              } else {
                next.set(taken, left);
              }
              return next;
            }),
        ),

      watermark: (current) =>
        Effect.gen(function* () {
          const open = yield* Ref.get(held);
          return open.size === 0 ? current : Math.min(...open.keys());
        }),

      held: Ref.get(held).pipe(Effect.map((open) => open.size)),
    });
  }),
);

/**
 * What survives below the watermark: for each key, the newest version at or
 * below it — a tombstone counts, since a read *at* the watermark must still
 * see that the key was deleted — plus everything above it.
 */
export const evict = (log: Log, watermark: Sequence) =>
  new Map(
    [...log].flatMap(([key, versions]) => {
      const base = versions
        .filter((entry) => entry.version <= watermark)
        .at(-1);
      const above = versions.filter((entry) => entry.version > watermark);
      const kept = base === undefined ? above : [base, ...above];
      return kept.length === 0 ? [] : [[key, kept] as const];
    }),
  );
