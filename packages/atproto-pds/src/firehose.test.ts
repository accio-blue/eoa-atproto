import { CODEC_DAG_CBOR, cidFromDigest, formatCid } from '@eoa/core';
import { Effect, Option, Result, Stream } from 'effect';
import {
  Firehose,
  type FirehoseOptions,
  type FirehoseShape,
  OutdatedCursorError,
  firehoseLayer,
} from './firehose.js';
import { describe, expect, it } from 'vitest';
import { sha256 } from '@eoa/crypto';

const bytes = (value: string) => new TextEncoder().encode(value);

/** A real block, so the CAR the stream carries is a real CAR. */
const blockOf = async (text: string) => {
  const digest = await Effect.runPromise(sha256(bytes(text)));
  return {
    cid: formatCid(cidFromDigest({ codec: CODEC_DAG_CBOR, digest })),
    bytes: bytes(text),
  };
};

const writeOf = async (over: {
  readonly did?: string;
  readonly text?: string;
}) => {
  const block = await blockOf(over.text ?? 'the record');
  return {
    time: '2026-01-01T00:00:00.000Z',
    timeUs: 1_000_000,
    did: over.did ?? 'did:web:pds.example:alice',
    commit: block.cid,
    rev: '3abc',
    since: null,
    ops: [
      {
        action: 'create' as const,
        path: 'app.bsky.feed.post/one',
        cid: block.cid,
      },
    ],
    blocks: [block],
  };
};

/** Run something that needs the stream. */
const withFirehose = <A, E>(
  use: (firehose: FirehoseShape) => Effect.Effect<A, E, never>,
  config?: FirehoseOptions,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const firehose = yield* Firehose;
      return yield* use(firehose);
    }).pipe(Effect.provide(firehoseLayer(config))),
  );

describe('the firehose', () => {
  it('puts a write on the stream with a position that always moves forward', async () => {
    const write = await writeOf({});
    const report = await withFirehose((firehose) =>
      Effect.gen(function* () {
        // The same `timeUs` twice: a position is a place, and two events cannot
        // share one even when the clock does.
        const first = yield* firehose.emit(write);
        const second = yield* firehose.emit(write);
        return { first, second, head: yield* firehose.head };
      }),
    );

    expect(Option.isSome(report.first)).toBe(true);
    expect(Option.getOrThrow(report.first).seq).toBe(1);
    expect(Option.getOrThrow(report.second).seq).toBe(2);
    expect(Option.getOrThrow(report.second).timeUs).toBeGreaterThan(
      Option.getOrThrow(report.first).timeUs,
    );
    expect(report.head.seq).toBe(2);
  });

  it('withholds a repo that is not public, and spends no position on it', async () => {
    const secret = await writeOf({ did: 'did:web:space.example' });
    const open = await writeOf({});
    const report = await withFirehose(
      (firehose) =>
        Effect.gen(function* () {
          const withheld = yield* firehose.emit(secret);
          const emitted = yield* firehose.emit(open);
          return { withheld, emitted };
        }),
      { isPublic: (did) => Effect.succeed(did !== 'did:web:space.example') },
    );

    expect(Option.isNone(report.withheld)).toBe(true);
    // Not an error, and not a place on the stream either.
    expect(Option.getOrThrow(report.emitted).seq).toBe(1);
  });

  it('refuses a cursor past the head, and one that fell out of the window', async () => {
    const write = await writeOf({});
    const report = await withFirehose(
      (firehose) =>
        Effect.gen(function* () {
          yield* firehose.emit(write);
          yield* firehose.emit(write);
          yield* firehose.emit(write);
          const head = yield* firehose.head;
          return {
            future: yield* Effect.result(firehose.cursorOf(head.timeUs + 1)),
            outdated: yield* Effect.result(firehose.cursorOf(0)),
          };
        }),
      { retained: 2 },
    );

    expect(Result.isFailure(report.future)).toBe(true);
    expect(Result.isFailure(report.outdated)).toBe(true);
    // A skipped record is worse than an error, so the refusal says which it was.
    if (Result.isFailure(report.outdated)) {
      expect(report.outdated.failure).toBeInstanceOf(OutdatedCursorError);
    }
  });

  it('replays the window a subscriber has not seen', async () => {
    const write = await writeOf({});
    const seen = await withFirehose((firehose) =>
      Effect.gen(function* () {
        const first = yield* firehose.emit(write);
        yield* firehose.emit(write);
        yield* firehose.emit(write);
        const replayed = yield* firehose
          .subscribe({ cursor: Option.getOrThrow(first).timeUs })
          .pipe(Stream.take(2), Stream.runCollect);
        return [...replayed].map((event) => event.seq);
      }),
    );

    expect(seen).toEqual([2, 3]);
  });

  it('carries the commit as a CAR, holding the blocks it touched', async () => {
    const write = await writeOf({ text: 'a record that is really here' });
    const event = await withFirehose((firehose) =>
      Effect.gen(function* () {
        return Option.getOrThrow(yield* firehose.emit(write));
      }),
    );

    expect(event.ops).toEqual(write.ops);
    // The CAR holds the block the commit carried, byte for byte.
    expect(
      Buffer.from(event.blocks).includes(
        Buffer.from(bytes('a record that is really here')),
      ),
    ).toBe(true);
  });
});

describe('a space on the same stream', () => {
  const spaceWrite = (params: {
    readonly space: string;
    readonly rkey: string;
  }) => ({
    time: '2026-01-01T00:00:00.000Z',
    timeUs: 2_000_000,
    space: params.space,
    did: 'did:web:pds.example:alice',
    rev: '3abc',
    action: 'create' as const,
    collection: 'ing.lexicon.note',
    rkey: params.rkey,
    cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    value: { $type: 'ing.lexicon.note', text: params.rkey },
  });

  it('reaches its own space and never the public stream', async () => {
    const club = 'at://did:web:pds.example:alice/ing.lexicon.space/club';
    const garden = 'at://did:web:pds.example:alice/ing.lexicon.space/garden';
    const open = await writeOf({ text: 'a public post' });
    const report = await withFirehose((firehose) =>
      Effect.gen(function* () {
        yield* firehose.emitSpace(spaceWrite({ space: club, rkey: 'one' }));
        yield* firehose.emitSpace(spaceWrite({ space: garden, rkey: 'two' }));
        const open$ = yield* firehose.emit(open);
        // From the beginning of the window: what each subscription *replays* is what it carries.
        const own = yield* firehose
          .subscribeSpaces({ spaces: [club], cursor: 0 })
          .pipe(Stream.take(1), Stream.runCollect);
        const other = yield* firehose
          .subscribeSpaces({ spaces: [garden], cursor: 0 })
          .pipe(Stream.take(1), Stream.runCollect);
        const seen = yield* firehose
          .subscribe({ cursor: 0 })
          .pipe(Stream.take(1), Stream.runCollect);
        return {
          own: [...own],
          other: [...other],
          seen: [...seen],
          openSeq: Option.isSome(open$) ? open$.value.seq : 0,
        };
      }),
    );

    // Each space's stream carries its own write, with the record as JSON — no CAR to unpack.
    expect(report.own).toHaveLength(1);
    expect(report.own[0]).toMatchObject({
      kind: 'space',
      space: 'at://did:web:pds.example:alice/ing.lexicon.space/club',
      rkey: 'one',
      value: { text: 'one' },
    });
    expect(report.other[0]).toMatchObject({ rkey: 'two' });
    // …and the public stream replays only the public write, so a space's event cannot leak there.
    expect(report.seen).toHaveLength(1);
    expect(report.seen[0]).toMatchObject({
      kind: 'commit',
      seq: report.openSeq,
    });
  });

  it('resumes a space stream from the position it left', async () => {
    const club = 'at://did:web:pds.example:alice/ing.lexicon.space/club';
    const report = await withFirehose((firehose) =>
      Effect.gen(function* () {
        const first = yield* firehose.emitSpace(
          spaceWrite({ space: club, rkey: 'one' }),
        );
        yield* firehose.emitSpace(spaceWrite({ space: club, rkey: 'two' }));
        const resumed = yield* firehose
          .subscribeSpaces({ spaces: [club], cursor: first.timeUs })
          .pipe(Stream.take(1), Stream.runCollect);
        return [...resumed];
      }),
    );
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ rkey: 'two' });
  });
});
