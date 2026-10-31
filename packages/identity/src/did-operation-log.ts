import { Clock, Context, Effect, Layer, Ref, Schema } from 'effect';
import {
  type PlcData,
  type PlcDidDocument,
  type PlcError,
  type PlcSignedOperation,
  PlcSignedOperationSchema,
  authorizingKeys,
  cidOfOperation,
  renderData,
  renderDocument,
  validateGenesisOperation,
  validateOperation,
  verifyOperationSignature,
} from './plc-operation.js';
import type { CryptoError } from '@eoa/crypto';
import { DID } from '@eoa/core';

/**
 * The directory's append-only operation log: one chain per DID, replayed to
 * reconstruct state.
 *
 * Append is where the operation model's rules become *log* rules, and the log
 * is where forks are resolved. A submitted operation must attach to an
 * operation already in the log, and attaching to anything but the current head
 * **nullifies** everything after it: a fork truncates the canonical chain
 * rather than branching it. Nothing is ever deleted, so the audit log keeps the
 * whole history - including operations that no longer count.
 *
 * The authorization for such a recovery is stricter than for a plain append:
 * the key signing it must outrank the key that signed the operation being
 * undone (`authorizingKeys`), which is what stops anyone who ever held any
 * rotation key from rewriting history.
 *
 * `seq` is a directory annotation, not part of the signed operation: it orders
 * `/export` and a mirror may assign its own.
 */

export class DuplicateOperationError extends Schema.TaggedError<DuplicateOperationError>()(
  'DuplicateOperationError',
  {
    message: Schema.String,
  },
) {}

export class MisorderedOperationError extends Schema.TaggedError<MisorderedOperationError>()(
  'MisorderedOperationError',
  {
    did: Schema.String,
    message: Schema.String,
  },
) {}

export class UnknownDidError extends Schema.TaggedError<UnknownDidError>()(
  'UnknownDidError',
  {
    did: Schema.String,
    message: Schema.String,
  },
) {}

export class TombstonedDidError extends Schema.TaggedError<TombstonedDidError>()(
  'TombstonedDidError',
  {
    did: Schema.String,
    message: Schema.String,
  },
) {}

/** Expected failures of an append. Reads fail differently (see the service shape). */
export type LogError = DuplicateOperationError | MisorderedOperationError;

/**
 * One accepted operation as the directory records it - the shape
 * `/log/audit` serves, with the signed operation included.
 */
export const IndexedEntrySchema = Schema.Struct({
  seq: Schema.Int,
  did: DID,
  cid: Schema.String,
  operation: PlcSignedOperationSchema,
  nullified: Schema.Boolean,
  createdAt: Schema.String,
});

export type IndexedEntry = Schema.Schema.Type<typeof IndexedEntrySchema>;

export interface DidOperationLogShape {
  /** Append an operation to its DID's chain, or reject it. */
  readonly append: (params: {
    readonly did: DID;
    readonly operation: PlcSignedOperation;
  }) => Effect.Effect<IndexedEntry, CryptoError | PlcError | LogError>;
  /** Every entry for a DID, oldest first, including nullified ones. */
  readonly history: (did: DID) => Effect.Effect<readonly IndexedEntry[]>;
  /** The canonical chain for a DID: the operations that still count. */
  readonly replay: (
    did: DID,
  ) => Effect.Effect<readonly PlcSignedOperation[], UnknownDidError>;
  /** The newest operation that still counts, if any. */
  readonly head: (did: DID) => Effect.Effect<IndexedEntry | undefined>;
  /** Replay a DID's canonical chain and project it to the DID document. */
  readonly resolve: (
    did: DID,
  ) => Effect.Effect<PlcDidDocument, UnknownDidError | TombstonedDidError>;
  /** The same replay, projected to the PLC state `/<did>/data` serves. */
  readonly resolveData: (
    did: DID,
  ) => Effect.Effect<PlcData, UnknownDidError | TombstonedDidError>;
}

export class DidOperationLog extends Context.Service<
  DidOperationLog,
  DidOperationLogShape
>()('@eoa/identity/DidOperationLog') {}

const entriesOf = (
  chains: ReadonlyMap<string, readonly IndexedEntry[]>,
  did: DID,
) => chains.get(did) ?? [];

/** The operations that still count: nullification is never reversed. */
const canonical = (entries: readonly IndexedEntry[]) =>
  entries.filter((entry) => !entry.nullified);

/**
 * Where a new operation attaches, and the authorization that goes with it.
 * Returns the log index of the operation being extended, or -1 for a genesis.
 */
const extendIndex = (params: {
  readonly did: DID;
  readonly existing: readonly IndexedEntry[];
  readonly operation: PlcSignedOperation;
}) =>
  Effect.gen(function* () {
    if (params.existing.length === 0) {
      yield* validateGenesisOperation({
        did: params.did,
        operation: params.operation,
      });
      return -1;
    }

    const { prev } = params.operation;
    if (prev === null) {
      return yield* new MisorderedOperationError({
        did: params.did,
        message: 'The DID already has a genesis operation',
      });
    }

    const extendedIndex = params.existing.findIndex(
      (entry) => entry.cid === prev,
    );
    const previous = params.existing[extendedIndex];
    if (extendedIndex < 0 || previous === undefined) {
      return yield* new MisorderedOperationError({
        did: params.did,
        message: `No logged operation has cid ${prev}`,
      });
    }

    // The operations that still count, and where this one attaches to them.
    // A nullified operation is history, not a branch to extend: it stays
    // nullified and cannot be resurrected.
    const chain = canonical(params.existing);
    const chainIndex = chain.findIndex((entry) => entry.cid === prev);
    if (chainIndex < 0) {
      return yield* new MisorderedOperationError({
        did: params.did,
        message: `${prev} was nullified and cannot be extended`,
      });
    }

    yield* validateOperation(params.operation);
    yield* verifyOperationSignature({
      operation: params.operation,
      allowedKeys: yield* authorizingKeys({
        previous: previous.operation,
        // Only the canonical tail is being undone. An already-nullified
        // operation is not a fork to resolve, so it does not set the bar the
        // recovery has to clear.
        nullifying: chain.slice(chainIndex + 1).map((entry) => entry.operation),
      }),
    });

    return extendedIndex;
  });

export const didOperationLogLayer: Layer.Layer<DidOperationLog> = Layer.effect(
  DidOperationLog,
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, readonly IndexedEntry[]>());

    const append: DidOperationLogShape['append'] = Effect.fn(
      'DidOperationLog.append',
    )(function* (params: { did: DID; operation: PlcSignedOperation }) {
      const { did, operation } = params;
      const cid = yield* cidOfOperation(operation);
      const existing = entriesOf(yield* Ref.get(state), did);

      if (existing.some((entry) => entry.cid === cid)) {
        return yield* new DuplicateOperationError({
          message: `Operation ${cid} is already logged`,
        });
      }

      const extendedIndex = yield* extendIndex({ did, existing, operation });

      const now = yield* Clock.currentTimeMillis;
      const entry: IndexedEntry = {
        seq: existing.length + 1,
        did,
        cid,
        operation,
        nullified: false,
        createdAt: new Date(now).toISOString(),
      };

      yield* Ref.update(state, (current) => {
        const next = new Map(current);
        next.set(did, [
          ...entriesOf(current, did).map((prior, index) =>
            index > extendedIndex ? { ...prior, nullified: true } : prior,
          ),
          entry,
        ]);
        return next;
      });

      return entry;
    });

    const history: DidOperationLogShape['history'] = Effect.fn(
      'DidOperationLog.history',
    )(function* (did: DID) {
      return entriesOf(yield* Ref.get(state), did);
    });

    const replay: DidOperationLogShape['replay'] = Effect.fn(
      'DidOperationLog.replay',
    )(function* (did: DID) {
      const entries = entriesOf(yield* Ref.get(state), did);
      if (entries.length === 0) {
        return yield* new UnknownDidError({
          did,
          message: `No operations are logged for ${did}`,
        });
      }
      return canonical(entries).map((entry) => entry.operation);
    });

    const head: DidOperationLogShape['head'] = Effect.fn(
      'DidOperationLog.head',
    )(function* (did: DID) {
      const entries = canonical(entriesOf(yield* Ref.get(state), did));
      return entries[entries.length - 1];
    });

    const resolve: DidOperationLogShape['resolve'] = Effect.fn(
      'DidOperationLog.resolve',
    )(function* (did: DID) {
      const headEntry = yield* head(did);
      if (headEntry === undefined) {
        return yield* new UnknownDidError({
          did,
          message: `No operations are logged for ${did}`,
        });
      }
      if (headEntry.operation.type === 'plc_tombstone') {
        return yield* new TombstonedDidError({
          did,
          message: `${did} is tombstoned and has no document`,
        });
      }
      return renderDocument({ did, operation: headEntry.operation });
    });

    const resolveData: DidOperationLogShape['resolveData'] = Effect.fn(
      'DidOperationLog.resolveData',
    )(function* (did: DID) {
      const headEntry = yield* head(did);
      if (headEntry === undefined) {
        return yield* new UnknownDidError({
          did,
          message: `No operations are logged for ${did}`,
        });
      }
      if (headEntry.operation.type === 'plc_tombstone') {
        return yield* new TombstonedDidError({
          did,
          message: `${did} is tombstoned and has no state`,
        });
      }
      return renderData({ did, operation: headEntry.operation });
    });

    return DidOperationLog.of({
      append,
      history,
      replay,
      head,
      resolve,
      resolveData,
    });
  }),
);
