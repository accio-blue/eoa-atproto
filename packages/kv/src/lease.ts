import { Context, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { ObjectStore, ifAbsent, ifHolds } from '@eoa/object-store';
import {
  type ObjectStoreError,
  ObjectStoreUnavailable,
} from '@eoa/object-store';

/** One shard's ownership: who holds it, and the epoch that fences the rest. */
export interface Lease {
  readonly owner: string;
  readonly epoch: number;
}

/** A writer's epoch is not the shard's any more: it has been fenced. */
export class LeaseLost extends Schema.TaggedError<LeaseLost>()('LeaseLost', {
  shard: Schema.String,
  epoch: Schema.Number,
}) {}

/** Too many writers raced for one shard; the caller may simply try again. */
export class LeaseContended extends Schema.TaggedError<LeaseContended>()(
  'LeaseContended',
  { shard: Schema.String },
) {}

export type LeaseError = LeaseLost | LeaseContended | ObjectStoreError;

export const leaseName = (shard: string) => `leases/${shard}`;

const LeaseRecord = Schema.Struct({
  owner: Schema.String,
  epoch: Schema.Number,
});

const decodeLease = Schema.decodeUnknownOption(
  Schema.fromJsonString(LeaseRecord),
);
const encodeLease = Schema.encodeSync(Schema.fromJsonString(LeaseRecord));

/** How many takeover attempts before a contended shard is reported as such. */
const ATTEMPTS = 8;

export interface ShardLeaseShape {
  /** Take the shard: create it if unowned, fence a predecessor if owned. */
  readonly acquire: (
    shard: string,
    owner: string,
  ) => Effect.Effect<Lease, LeaseError>;
  /** The shard's lease as it stands, if anything owns it. */
  readonly read: (
    shard: string,
  ) => Effect.Effect<Option.Option<Lease>, ObjectStoreError>;
  /**
   * Fail unless `epoch` is still the shard's — the check a writer makes with
   * every write, so a writer that has been fenced fails rather than landing
   * quietly.
   */
  readonly fence: (
    shard: string,
    epoch: number,
  ) => Effect.Effect<void, LeaseLost | ObjectStoreError>;
}

/**
 * The shard-lease protocol over the object store (the Effect-PDS map, `fzgn`).
 *
 * Ownership is one object per shard, `leases/{shard}`, holding the owner and
 * the **epoch**. It is taken with a conditional PUT — `If-None-Match` when the
 * shard is unowned, `If-Match` on the current etag to **fence a predecessor**.
 * There is no renewal TTL: takeover *is* the bump, so a writer whose epoch has
 * moved learns it at its next `fence` rather than from a heartbeat it stopped
 * sending.
 */
export const makeShardLease = (objects: ObjectStore['Service']) => {
  const held = (shard: string) =>
    objects.get(leaseName(shard)).pipe(
      Effect.flatMap((found) => {
        if (Option.isNone(found)) {
          return Effect.succeed(
            Option.none<{ readonly lease: Lease; readonly etag: string }>(),
          );
        }
        const decoded = decodeLease(new TextDecoder().decode(found.value.body));
        return Option.isNone(decoded)
          ? Effect.fail(
              new ObjectStoreUnavailable({
                key: leaseName(shard),
                message: 'the lease object is not a lease',
              }),
            )
          : Effect.succeed(
              Option.some({ lease: decoded.value, etag: found.value.etag }),
            );
      }),
    );

  /** One attempt: the lease if we took it, or a contention to try again. */
  const attempting = (shard: string, owner: string) =>
    Effect.gen(function* () {
      const current = yield* held(shard);
      if (Option.isSome(current) && current.value.lease.owner === owner) {
        return current.value.lease;
      }

      const next: Lease = Option.isSome(current)
        ? { owner, epoch: current.value.lease.epoch + 1 }
        : { owner, epoch: 1 };
      return yield* objects
        .put(
          leaseName(shard),
          new TextEncoder().encode(encodeLease(next)),
          Option.isSome(current)
            ? ifHolds({ etag: current.value.etag })
            : ifAbsent(),
        )
        .pipe(
          Effect.as(next),
          // Somebody else moved first: not a failure, a reason to look again.
          Effect.catchTag('PreconditionFailed', () =>
            Effect.fail(new LeaseContended({ shard })),
          ),
        );
    });

  return {
    acquire: (shard: string, owner: string) =>
      attempting(shard, owner).pipe(
        Effect.retry({
          times: ATTEMPTS - 1,
          while: (error) => Predicate.isTagged(error, 'LeaseContended'),
        }),
      ),
    read: (shard: string) =>
      held(shard).pipe(Effect.map(Option.map((holding) => holding.lease))),
    fence: (shard: string, epoch: number) =>
      held(shard).pipe(
        Effect.flatMap((current) =>
          Option.isSome(current) && current.value.lease.epoch === epoch
            ? Effect.void
            : Effect.fail(new LeaseLost({ shard, epoch })),
        ),
      ),
  };
};

export class ShardLease extends Context.Service<ShardLease, ShardLeaseShape>()(
  '@eoa/kv/ShardLease',
) {}

export const shardLeaseLayer = Layer.effect(
  ShardLease,
  Effect.gen(function* () {
    return ShardLease.of(makeShardLease(yield* ObjectStore));
  }),
);
