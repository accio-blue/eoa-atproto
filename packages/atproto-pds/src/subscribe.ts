import { type CborValue, CidLink, encodeCbor, parseCid } from '@eoa/core';
import {
  type CommitEvent,
  type Firehose,
  FutureCursorError,
  type IdentityEvent,
  OutdatedCursorError,
} from './firehose.js';
import { Effect, Option, Result, Schema, Stream } from 'effect';
import { type HandlerContext } from '@eoa/xrpc-server';

/**
 * `com.atproto.sync.subscribeRepos` (the Effect-PDS map, `bbny`).
 *
 * sync 1.1 is a **framed** stream: each message is the CBOR of a header —
 * `{op: 1, t: '#commit'}` — followed immediately by the CBOR of its body, so a
 * reader takes two CBOR items off the message and knows what it has. That is the
 * whole of the protocol, and it is the whole of what lives here: the framing,
 * and the cursor.
 *
 * The socket is not here. The transport owns it (`server.stream` routes the
 * upgrade by path), and this answers with the bytes to put on it — because only
 * this knows what a `#commit` is, and the transport should not have to.
 */

/** The NSID this serves, and the path a client reaches it at. */
export const SUBSCRIBE_NSID = 'com.atproto.sync.subscribeRepos';

export const SUBSCRIBE_PATH = `/xrpc/${SUBSCRIBE_NSID}`;

/** An event whose CIDs do not parse — a corrupt row, not a bad request. */
export class BadEvent extends Schema.TaggedError<BadEvent>()('BadEvent', {
  cid: Schema.String,
}) {}

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  parts.reduce((at, part) => {
    joined.set(part, at);
    return at + part.length;
  }, 0);
  return joined;
};

/** One frame: the header, then the body, back to back. */
const frame = (type: string, body: CborValue) =>
  concat([encodeCbor({ op: 1, t: type }), encodeCbor(body)]);

/** A CID string as the link a frame carries, or nothing when it does not parse. */
const linkOf = (cid: string) => {
  const parsed = parseCid(cid);
  return Result.isFailure(parsed)
    ? Option.none<CidLink>()
    : Option.some(new CidLink({ cid: parsed.success }));
};

/** A `#commit` event, as atproto carries it. */
const commitBody = (event: CommitEvent) =>
  Effect.gen(function* () {
    const commit = linkOf(event.commit);
    if (Option.isNone(commit)) {
      return yield* Effect.fail(new BadEvent({ cid: event.commit }));
    }
    const since =
      event.since === null ? Option.none<CidLink>() : linkOf(event.since);
    if (event.since !== null && Option.isNone(since)) {
      return yield* Effect.fail(new BadEvent({ cid: event.since }));
    }
    const ops = yield* Effect.forEach(event.ops, (op) => {
      const link = op.cid === null ? Option.none<CidLink>() : linkOf(op.cid);
      return op.cid !== null && Option.isNone(link)
        ? Effect.fail(new BadEvent({ cid: op.cid }))
        : Effect.succeed({
            action: op.action,
            path: op.path,
            cid: Option.isNone(link) ? null : link.value,
          });
    });

    const body: CborValue = {
      seq: event.seq,
      // We never split a commit, and we never serve a rebased one.
      rebase: false,
      tooBig: event.tooBig,
      repo: event.did,
      commit: commit.value,
      rev: event.rev,
      since: Option.isNone(since) ? null : since.value,
      blocks: event.blocks,
      ops,
      time: event.time,
    };
    return body;
  });

/**
 * An `#identity` event, as atproto carries it: the DID, the moment, and no repo
 * state — the reader re-resolves the document itself.
 */
const identityBody = (event: IdentityEvent) => ({
  seq: event.seq,
  did: event.did,
  time: event.time,
  ...(event.handle === undefined ? {} : { handle: event.handle }),
});

/** The `#info` name for a cursor we could not honour. */
const nameOf = (error: FutureCursorError | OutdatedCursorError) =>
  error instanceof FutureCursorError ? 'FutureCursor' : 'OutdatedCursor';

/** The cursor a connection asked for, when it asked for one we can read. */
const cursorOf = (ctx: HandlerContext) => {
  const asked = ctx.params['cursor'];
  const parsed = asked === undefined ? Number.NaN : Number(asked);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The stream, as bytes: the window first, then the live events, each framed.
 *
 * A cursor we cannot honour is **said out loud before any frame**, and then the
 * stream ends — which is what closes the socket. A client that resumes from a
 * cursor the window has moved past needs to know to start over rather than wait
 * for an event that will never come, and `cursorOf` is already the check that
 * says so.
 */
export const subscribeReposHandler =
  (firehose: Firehose['Service']) => (ctx: HandlerContext) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const resumeFrom = yield* firehose
          .cursorOf(cursorOf(ctx))
          .pipe(Effect.result);
        if (Result.isFailure(resumeFrom)) {
          return Stream.make(
            frame('#info', { name: nameOf(resumeFrom.failure) }),
          );
        }

        return firehose.subscribe({ cursor: resumeFrom.success }).pipe(
          // An `#account` event is deliberately not a frame here. This socket is the repo
          // syncer's: its two frames are `#commit` and `#identity`, and neither describes an
          // account's status. The consumer that needs to know a member went away reads
          // Jetstream, which carries the `account` frame (`lfmr`); translating the same event a
          // second way here would be a second shape to keep, with no reader asking for it.
          Stream.filter(
            (event): event is CommitEvent | IdentityEvent =>
              event.kind !== 'account',
          ),
          Stream.mapEffect((event) =>
            event.kind === 'identity'
              ? Effect.succeed(frame('#identity', identityBody(event)))
              : Effect.map(commitBody(event), (body) => frame('#commit', body)),
          ),
        );
      }),
    );
