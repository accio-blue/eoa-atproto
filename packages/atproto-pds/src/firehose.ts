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
 * **A repo that is not public does not go on the public stream.** A permissioned
 * space's writes are its members' business, and a firehose is not a member of anything
 * — so `subscribe` keeps public events only, and a space's writes go out on that
 * space's own subscription (`subscribeSpaces`), where the caller has already said who
 * it is. The withholding is `subscribe`'s predicate, not each caller's, so no
 * route can forget it.
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

/**
 * An `#account` event: the account's status moved, so a reader that shows the
 * account's records can hide or show them again (spaces: a deactivated member's
 * records are hidden in every space, `lfmr`).
 *
 * It is a **public** event, like `#identity` and never like a space write: an
 * account going away is the firehose's oldest job, and a space reader gets it
 * from the public stream rather than from its space's own subscription.
 *
 * `status` is the row's own word (`created`, `active`, `suspended`, `deleted`)
 * rather than a second vocabulary: a consumer that needs atproto's four words
 * maps them where it knows the difference.
 */
export interface AccountEvent {
  readonly kind: 'account';
  readonly seq: number;
  readonly timeUs: number;
  readonly time: string;
  readonly did: string;
  /** Whether the account is live after the move; `status` says from where. */
  readonly active: boolean;
  readonly status: string;
}

/**
 * One record a space took, as a space's own stream carries it.
 *
 * A space repo is not an MST repo, so there is no CAR to hand out: the frame is the record itself,
 * JSON-shaped, one per operation — which is the shape a reader of a space actually consumes.
 *
 * **It never appears on the public stream.** `subscribe` keeps public events only; a space's writes
 * are delivered by `subscribeSpaces`, where the caller has already said who it is.
 */
export interface SpaceCommitEvent {
  readonly kind: 'space';
  readonly seq: number;
  readonly timeUs: number;
  readonly time: string;
  /** The space this write is in, as `at://…`. */
  readonly space: string;
  readonly did: string;
  readonly rev: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly collection: string;
  readonly rkey: string;
  readonly cid: string;
  /** The record as JSON, on a create or update; a delete has none. */
  readonly value?: Schema.Json | undefined;
}

/** What the emitter supplies for a space event; the stream assigns `seq` and `timeUs`. */
export interface SpaceCommitWrite {
  readonly time: string;
  readonly timeUs: number;
  readonly space: string;
  readonly did: string;
  readonly rev: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly collection: string;
  readonly rkey: string;
  readonly cid: string;
  readonly value?: Schema.Json | undefined;
}

/** Anything the stream carries. */
export type FirehoseEvent =
  | CommitEvent
  | IdentityEvent
  | SpaceCommitEvent
  | AccountEvent;

/** What the emitter supplies for an identity event. */
export interface IdentityWrite {
  readonly time: string;
  readonly timeUs: number;
  readonly did: string;
  readonly handle?: string;
}

/** What the emitter supplies for an account event. */
export interface AccountWrite {
  readonly time: string;
  readonly timeUs: number;
  readonly did: string;
  readonly active: boolean;
  readonly status: string;
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
   * Put an account's new status on the stream. Never withheld: an account going
   * away is exactly what the public stream is for, and it names no repo state
   * a permissioned space could keep private.
   */
  readonly emitAccount: (write: AccountWrite) => Effect.Effect<AccountEvent>;
  /**
   * Put a space's write on the stream. Never withheld: a space stream is only served to a caller
   * that may read the space, so the filter is at the subscription, not here.
   */
  readonly emitSpace: (
    write: SpaceCommitWrite,
  ) => Effect.Effect<SpaceCommitEvent>;
  /**
   * The position a subscription would resume from, or the reason it cannot:
   * checked before a response starts, so a cursor is refused with a status
   * rather than by dying halfway through a stream.
   */
  readonly cursorOf: (
    cursor?: number | undefined,
  ) => Effect.Effect<number, FutureCursorError | OutdatedCursorError>;
  /** The public stream: commits, identity and account events, never a space's writes. */
  readonly subscribe: (params: {
    readonly cursor?: number | undefined;
  }) => Stream.Stream<
    CommitEvent | IdentityEvent | AccountEvent,
    FutureCursorError | OutdatedCursorError
  >;
  /**
   * The writes of a **set** of spaces, and nothing else.
   *
   * A set rather than one space because Jetstream serves one subscription for every space a caller
   * follows, and the post's contract is one ordered stream: taking them through this one window
   * keeps a single `timeUs` order, where merging per-space streams would interleave arbitrarily. The
   * socket that serves one space passes a one-element set.
   */
  readonly subscribeSpaces: (params: {
    readonly spaces: readonly string[];
    readonly cursor?: number | undefined;
  }) => Stream.Stream<
    SpaceCommitEvent,
    FutureCursorError | OutdatedCursorError
  >;
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

      /**
       * A subscription over the events `accepts` keeps, resumable from `cursor`.
       *
       * One stream serves the public firehose and each space: the window, the position and the
       * ordering are shared, so a cursor is a place in either, and the filter is what keeps a
       * permissioned write off the stream anyone may read.
       */
      const tail = <A extends FirehoseEvent>(
        accepts: (event: FirehoseEvent) => event is A,
        cursor: number | undefined,
      ): Stream.Stream<A, FutureCursorError | OutdatedCursorError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // The position, then the registration, then the window: the order
            // that closes the gap. Registering before reading is what makes an
            // event published during the handover arrive exactly once.
            const resumeFrom = yield* cursorOf(cursor);

            const queue = yield* Queue.unbounded<FirehoseEvent>();
            yield* Ref.update(subscribers, (held) => [...held, queue]);

            const window = yield* Ref.get(events);
            const replayed = window
              .filter((event) => event.timeUs > resumeFrom)
              .filter(accepts);
            const newest = window.at(-1);

            // Everything still queued that is not a replay of what was just
            // read: the window is monotone, so the comparison is exact.
            const after = (event: FirehoseEvent) =>
              event.timeUs > (newest?.timeUs ?? resumeFrom) && accepts(event);
            const live = Stream.fromQueue(queue).pipe(
              Stream.filter(after),
              // The cast is `accepts`, already applied: `Stream.filter` takes a predicate and
              // cannot carry its refinement through, so the stream is narrowed here instead.
              Stream.map((event) => event as A),
            );

            return Stream.concat(Stream.fromIterable(replayed), live).pipe(
              Stream.onExit(() =>
                Ref.update(subscribers, (held) =>
                  held.filter((each) => each !== queue),
                ),
              ),
            );
          }),
        );

      const isPublicEvent = (
        event: FirehoseEvent,
      ): event is CommitEvent | IdentityEvent | AccountEvent =>
        event.kind !== 'space';

      const isSpaceIn =
        (spaces: ReadonlySet<string>) =>
        (event: FirehoseEvent): event is SpaceCommitEvent =>
          event.kind === 'space' && spaces.has(event.space);

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

        emitSpace: (write) =>
          append({
            timeUs: write.timeUs,
            make: (stamp) => ({
              kind: 'space',
              ...stamp,
              time: write.time,
              space: write.space,
              did: write.did,
              rev: write.rev,
              action: write.action,
              collection: write.collection,
              rkey: write.rkey,
              cid: write.cid,
              ...(write.value === undefined ? {} : { value: write.value }),
            }),
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

        emitAccount: (write) =>
          append({
            timeUs: write.timeUs,
            make: (stamp) => ({
              kind: 'account',
              ...stamp,
              time: write.time,
              did: write.did,
              active: write.active,
              status: write.status,
            }),
          }),

        subscribe: (params) => tail(isPublicEvent, params.cursor),
        subscribeSpaces: (params) =>
          tail(isSpaceIn(new Set(params.spaces)), params.cursor),
      } satisfies FirehoseShape;
    }),
  );
