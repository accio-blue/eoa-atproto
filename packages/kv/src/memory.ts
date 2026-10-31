import {
  EMPTY,
  Holds,
  commitTo,
  holdsLayer,
  scanState,
  valueAt,
} from './engine.js';
import { Effect, Layer, Match, Option, Ref } from 'effect';
import type { OpMap, ScanOptions, Sequence } from './types.js';
import { SnapshotExpired, deleteOp, putOp } from './types.js';
import { Kv } from './kv.js';

/**
 * The in-memory backend — what development runs on (the Effect-PDS map,
 * `uasm`), under the same contract the object store will have to meet.
 *
 * It never drops anything, but it still **refuses a read below the watermark**:
 * history is read under a hold everywhere, so development cannot read history
 * the bucket would refuse.
 */
export const kvMemoryLayer: Layer.Layer<Kv> = Layer.effect(
  Kv,
  Effect.gen(function* () {
    const state = yield* Ref.make(EMPTY);
    const holds = yield* Holds;
    const now = Ref.get(state).pipe(Effect.map((current) => current.sequence));

    const within = (moment: Sequence, oldest: Sequence) =>
      moment < oldest
        ? Effect.fail(new SnapshotExpired({ at: moment, oldest }))
        : Effect.void;

    const commit = (ops: ReadonlyArray<OpMap>) =>
      Ref.modify(state, (current) => {
        const result = commitTo(current, ops);
        return [
          result,
          Match.value(result).pipe(
            Match.tag('committed', (done) => done.state),
            Match.orElse(() => current),
          ),
        ];
      }).pipe(
        Effect.flatMap((result) =>
          Match.value(result).pipe(
            Match.tagsExhaustive({
              committed: (done) => Effect.succeed(done.state.sequence),
              rejected: (bad) => Effect.fail(bad.error),
            }),
          ),
        ),
      );

    return Kv.of({
      sequence: now,

      get: (key, at) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const moment = at ?? current.sequence;
          yield* within(moment, yield* holds.watermark(current.sequence));
          return Option.map(valueAt(current.log, key, moment), (found) => ({
            key,
            value: found.value,
            version: found.version,
          }));
        }),

      getMany: (keys, at) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const moment = at ?? current.sequence;
          yield* within(moment, yield* holds.watermark(current.sequence));
          return keys.flatMap((key) =>
            Option.toArray(valueAt(current.log, key, moment)).map((found) => ({
              key,
              value: found.value,
              version: found.version,
            })),
          );
        }),

      put: (key, value, condition) =>
        commit([
          condition === undefined
            ? putOp({ key, value })
            : putOp({ key, value, condition }),
        ]),

      delete: (key, condition) =>
        commit([
          condition === undefined
            ? deleteOp({ key })
            : deleteOp({ key, condition }),
        ]),

      batch: commit,

      scan: (options: ScanOptions | undefined) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const page = yield* scanState(current, options);
          yield* within(page.at, yield* holds.watermark(current.sequence));
          return page;
        }),

      snapshot: (at) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const wanted = at ?? current.sequence;
          yield* within(wanted, yield* holds.watermark(current.sequence));
          return yield* holds.snapshot(wanted);
        }),
    });
  }),
).pipe(Layer.provide(holdsLayer));
