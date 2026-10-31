import type {
  ConditionMap,
  Entry,
  Key,
  KvError,
  OpMap,
  ScanOptions,
  ScanPage,
  Sequence,
  Value,
} from './types.js';
import { Context, type Effect, type Option, type Scope } from 'effect';

/**
 * The ordered key-value seam (the Effect-PDS map, ticket `15kf`).
 *
 * One contract for every backend: memory, filesystem and the object store owe
 * the same guarantees, so development cannot hide a bug a bucket would expose.
 *
 * Reads are **snapshot reads** — every entry carries the sequence it was written
 * at, a reader may ask for any past sequence, and a writer always sees its own
 * writes. Writes are **batched and atomic**, and every accepted batch advances
 * one sequence. Scans are **resumable**: the cursor they return carries the
 * snapshot, so a scan survives a restart rather than restarting from the top.
 */
export class Kv extends Context.Service<
  Kv,
  {
    /** The sequence a read with no explicit `at` would use. */
    readonly sequence: Effect.Effect<Sequence, KvError>;
    readonly get: (
      key: Key,
      at?: Sequence,
    ) => Effect.Effect<Option.Option<Entry>, KvError>;
    readonly getMany: (
      keys: ReadonlyArray<Key>,
      at?: Sequence,
    ) => Effect.Effect<ReadonlyArray<Entry>, KvError>;
    /** Returns the sequence the write landed at. */
    readonly put: (
      key: Key,
      value: Value,
      condition?: ConditionMap,
    ) => Effect.Effect<Sequence, KvError>;
    readonly delete: (
      key: Key,
      condition?: ConditionMap,
    ) => Effect.Effect<Sequence, KvError>;
    /** Apply every op at one sequence, or none of them. */
    readonly batch: (
      ops: ReadonlyArray<OpMap>,
    ) => Effect.Effect<Sequence, KvError>;
    readonly scan: (options?: ScanOptions) => Effect.Effect<ScanPage, KvError>;
    /**
     * Hold a snapshot at `at` (default: now) for as long as the enclosing
     * scope lives, and answer with the sequence it took. History at or above it
     * is guaranteed readable; nothing below it may be dropped while it is held.
     */
    readonly snapshot: (
      at?: Sequence,
    ) => Effect.Effect<Sequence, KvError, Scope.Scope>;
  }
>()('@eoa/kv/Kv') {}
