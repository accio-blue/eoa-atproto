import { type Cid, parseCid } from '@eoa/core';
import { type CommitBlock, type CommitOp, encodeCar } from '@eoa/repo-store';
import {
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from 'effect';

/**
 * The firehose: an ordered, resumable stream of the commits this PDS has written
 * (the Effect-PDS map, `msbm`).
 *
 * Every write becomes one `#commit` event carrying the position that orders it,
 * the operations it performed with the blocks they need, and the time it was
 * written. A reader that remembers the last position it saw resumes from exactly
 * there, which is what makes the stream resumable rather than a live tail.
 *
 * The stream keeps a **window** and no archive: the events are the repositories'
 * own commits, still fetchable from the PDS as a CAR, so backfill is
 * `sync.getRepo` and not the stream's job. An older cursor is therefore refused
 * *by name* rather than silently skipped, because a skipped record is worse than
 * an error.
 *
 * **A repo that is not public does not go on the stream.** A permissioned space's
 * writes are its members' business, and a firehose is not a member of anything —
 * so the check is here, at the one place an event is created, rather than in
 * every caller that might forget it. Nothing is a permissioned space yet, so the
 * default says yes to everything; the seam is what spaces plug into.
 */

/** One operation of a commit, as the stream carries it. */
export type FirehoseOp = CommitOp;

/** A `#commit` event, with the position that orders it. */
export interface CommitEvent {
  readonly kind: 'commit';
  /** The ordering position. Resuming passes the last one seen. */
  readonly seq: number;
  /** Microseconds, strictly increasing across the stream. */
  readonly timeUs: number;
  /** The write time, as the firehose carries it. */
  readonly time: string;
  readonly did: string;
  /** The commit's own CID: what a reader addresses the revision by. */
  readonly commit: string;
  /** The revision this commit produced. */
  readonly rev: string;
  /** The previous revision, or `null` for a repository's first commit. */
  readonly since: string | null;
  readonly ops: ReadonlyArray<FirehoseOp>;
  /**
   * The CAR a reader ingests: the commit block, its tree, and the records the
   * operations touched — not the whole repository.
   */
  readonly blocks: Uint8Array;
  /** Set when a commit is too large to carry its blocks; we never split one. */
  readonly tooBig: boolean;
}

/**
 * An `#identity` event: the account's DID document changed, so a cached copy of
 * it is stale (spaces alpha, 2026-10-22, §7 — a published `#atproto_kem` key is
 * the first thing that needs one).
 *
 * It carries no repo state at all: a reader that hears this re-resolves the DID
 * and goes on reading the repo it already knows.
 */
export interface IdentityEvent {
  readonly kind: 'identity';
  readonly seq: number;
  readonly timeUs: number;
  readonly time: string;
  readonly did: string;
  /** The handle the event is about, when it was known at the time. */
  readonly handle?: string;
}

/** Anything the stream carries. */
export type FirehoseEvent = CommitEvent | IdentityEvent;

/** What the emitter supplies for an identity event. */
export interface IdentityWrite {
  readonly time: string;
  readonly timeUs: number;
  readonly did: string;
  readonly handle?: string;
}

/** What the emitter supplies; the stream assigns `seq` and `timeUs`. */
export interface CommitWrite {
  readonly time: string;
  readonly timeUs: number;
  readonly did: string;
  /** The commit's own CID: what a reader addresses the revision by. */
  readonly commit: string;
  readonly rev: string;
  readonly since: string | null;
  readonly ops: ReadonlyArray<FirehoseOp>;
  readonly blocks: ReadonlyArray<CommitBlock>;
}

/** A commit's blocks, under a CID that does not parse — a corrupt row, not a request. */
export class InvalidCid extends Schema.TaggedError<InvalidCid>()('InvalidCid', {
  cid: Schema.String,
}) {}

/** Reported when a subscriber asks to resume past the head of the stream. */
export class FutureCursorError extends Schema.TaggedError<FutureCursorError>()(
  'FutureCursorError',
  { cursor: Schema.Finite, head: Schema.Finite },
) {}

/** Reported when a subscriber's cursor has fallen out of the retained window. */
export class OutdatedCursorError extends Schema.TaggedError<OutdatedCursorError>()(
  'OutdatedCursorError',
  { cursor: Schema.Finite, retainedFrom: Schema.Finite },
) {}

/** How many events the stream keeps for a resuming reader. */
export const DEFAULT_RETAINED_EVENTS = 512;

/** The CAR a commit carries: the commit, its tree, and the records it touched. */
export const commitCar = (blocks: ReadonlyArray<CommitBlock>) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.forEach(blocks, (block) => {
      const cid = parseCid(block.cid);
      return Result.isFailure(cid)
        ? Effect.fail(new InvalidCid({ cid: block.cid }))
        : Effect.succeed({ cid: cid.success, bytes: block.bytes });
    });
    const root: Cid | undefined = parsed.at(0)?.cid;
    return root === undefined
      ? yield* Effect.fail(new InvalidCid({ cid: '' }))
      : encodeCar({ roots: [root], blocks: parsed });
  });

/** What a firehose offers: emit, resume, and read the head. */
export interface FirehoseShape {
  /**
   * Put a write on the stream — or nothing, when the repo it belongs to is not
   * public. A withheld write is not an error and does not take a position.
   */
  readonly emit: (
    write: CommitWrite,
  ) => Effect.Effect<Option.Option<CommitEvent>, InvalidCid>;
  /**
   * Put an identity event on the stream. Never withheld: a DID document is
   * public whether or not the account's repo is, and a stale document is exactly
   * what a syncer must not keep verifying against.
   */
  readonly emitIdentity: (write: IdentityWrite) => Effect.Effect<IdentityEvent>;
  /**
   * The position a subscription would resume from, or the reason it cannot:
   * checked before a response starts, so a cursor is refused with a status
   * rather than by dying halfway through a stream.
   */
  readonly cursorOf: (
    cursor?: number | undefined,
  ) => Effect.Effect<number, FutureCursorError | OutdatedCursorError>;
  readonly subscribe: (params: {
    readonly cursor?: number | undefined;
  }) => Stream.Stream<FirehoseEvent, FutureCursorError | OutdatedCursorError>;
  readonly head: Effect.Effect<{
    readonly seq: number;
    readonly timeUs: number;
  }>;
}

export class Firehose extends Context.Service<Firehose, FirehoseShape>()(
  '@eoa/atproto-pds/Firehose',
) {}

export interface FirehoseOptions {
  /** How many events the stream keeps for a resuming reader. */
  readonly retained?: number | undefined;
  /**
   * Whether a repo's commits belong on the stream. The default says yes to
   * everything, because nothing is a permissioned space yet.
   */
  readonly isPublic?: ((did: string) => Effect.Effect<boolean>) | undefined;
}

/**
 * The firehose over an in-memory window, which is all this needs: the events are
 * the repositories' own commits, still fetchable as CARs, so the stream keeps no
 * archive of its own.
 */
export const firehoseLayer = (config?: FirehoseOptions) =>
  Layer.effect(
    Firehose,
    Effect.gen(function* () {
      const retained = config?.retained ?? DEFAULT_RETAINED_EVENTS;
      const isPublic = config?.isPublic ?? (() => Effect.succeed(true));
      const events = yield* Ref.make<ReadonlyArray<FirehoseEvent>>([]);
      const head = yield* Ref.make({ seq: 0, timeUs: 0 });
      /** The newest event dropped from the window: `0` until one is. */
      const droppedThrough = yield* Ref.make(0);
      const subscribers = yield* Ref.make<
        ReadonlyArray<Queue.Queue<FirehoseEvent>>
      >([]);

      /**
       * Give an event its place, then put it in the window and on every queue.
       *
       * The two steps are one function because the promise the stream makes is
       * one promise: a position is only useful to a subscriber that can also
       * read the event at it, and a commit and an identity event queue behind
       * each other in exactly the same order.
       */
      const append = <Event extends FirehoseEvent>(params: {
        readonly timeUs: number;
        readonly make: (stamp: {
          readonly seq: number;
          readonly timeUs: number;
        }) => Event;
      }) =>
        Effect.gen(function* () {
          const stamped = yield* Ref.modify(head, (previous) => {
            // Strictly increasing, even when the clock is not: a position is a
            // place, and two events at one place would be ambiguous.
            const next = {
              seq: previous.seq + 1,
              timeUs: Math.max(params.timeUs, previous.timeUs + 1),
            };
            return [next, next];
          });
          const event = params.make(stamped);

          // The window first, then the queues: a subscriber registers before it
          // reads the window, so an event published while it registers is either
          // already in the window or already in its queue — never in neither,
          // which is the whole promise of the cursor.
          const dropped = yield* Ref.modify(events, (held) => {
            const grown = [...held, event];
            const overflow = Math.max(0, grown.length - retained);
            return [grown.slice(0, overflow), grown.slice(overflow)];
          });
          const lastDropped = dropped.at(-1);
          if (lastDropped !== undefined) {
            yield* Ref.set(droppedThrough, lastDropped.timeUs);
          }

          const held = yield* Ref.get(subscribers);
          yield* Effect.forEach(held, (queue) => Queue.offer(queue, event), {
            discard: true,
          });

          return event;
        });

      /** The position a subscription resumes from, or why it cannot. */
      const cursorOf = (cursor: number | undefined) =>
        Effect.gen(function* () {
          const started = yield* Ref.get(head);
          if (cursor !== undefined && cursor > started.timeUs) {
            return yield* Effect.fail(
              new FutureCursorError({ cursor, head: started.timeUs }),
            );
          }
          const floor = yield* Ref.get(droppedThrough);
          if (cursor !== undefined && cursor < floor) {
            return yield* Effect.fail(
              new OutdatedCursorError({ cursor, retainedFrom: floor }),
            );
          }
          return cursor ?? started.timeUs;
        });

      return {
        head: Ref.get(head),
        cursorOf,

        emit: (write) =>
          Effect.gen(function* () {
            if (!(yield* isPublic(write.did))) {
              return Option.none<CommitEvent>();
            }
            const car = yield* commitCar(write.blocks);
            const event = yield* append({
              timeUs: write.timeUs,
              make: (stamp) => ({
                kind: 'commit',
                ...stamp,
                time: write.time,
                did: write.did,
                commit: write.commit,
                rev: write.rev,
                since: write.since,
                ops: write.ops,
                blocks: car,
                tooBig: false,
              }),
            });
            return Option.some(event);
          }),

        emitIdentity: (write) =>
          append({
            timeUs: write.timeUs,
            make: (stamp) => ({
              kind: 'identity',
              ...stamp,
              time: write.time,
              did: write.did,
              ...(write.handle === undefined ? {} : { handle: write.handle }),
            }),
          }),

        subscribe: (params) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // The position, then the registration, then the window: the order
              // that closes the gap. Registering before reading is what makes an
              // event published during the handover arrive exactly once.
              const resumeFrom = yield* cursorOf(params.cursor);

              const queue = yield* Queue.unbounded<FirehoseEvent>();
              yield* Ref.update(subscribers, (held) => [...held, queue]);

              const window = yield* Ref.get(events);
              const replayed = window.filter(
                (event) => event.timeUs > resumeFrom,
              );
              const newest = window.at(-1);

              // Everything still queued that is not a replay of what was just
              // read: the window is monotone, so the comparison is exact.
              const live = Stream.fromQueue(queue).pipe(
                Stream.filter(
                  (event) => event.timeUs > (newest?.timeUs ?? resumeFrom),
                ),
              );

              return Stream.concat(Stream.fromIterable(replayed), live).pipe(
                Stream.onExit(() =>
                  Ref.update(subscribers, (held) =>
                    held.filter((each) => each !== queue),
                  ),
                ),
              );
            }),
          ),
      } satisfies FirehoseShape;
    }),
  );
