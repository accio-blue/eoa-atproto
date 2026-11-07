import {
  CanonicalStore,
  type CanonicalStoreShape,
  canonicalStoreLayer,
} from './canonical-store.js';
import { Effect, Stream } from 'effect';
import { type IndexFrame, type LiveIngestError } from './live.js';
import { applyFrame, ingestCanonical } from './canonical-ingest.js';
import { describe, expect, it } from 'vitest';
import { type CborValue } from '@eoa/core';

/**
 * The canonical ingest wire's contract: frames apply in `time_us` order and the
 * returned cursor is the last one; a frame at or below the cursor is a
 * stale/duplicate the pipeline rule ignores, so the store does not grow; and a
 * frame with no record removes its URI. Every case runs against a real
 * `canonicalStoreLayer` in one provided scenario, since the store is rebuilt
 * per `Effect.provide`.
 */

const DID = 'did:plc:genesis';
const POST = 'app.bsky.feed.post';

const recordPath = (rkey: string) => `at://${DID}/${POST}/${rkey}`;

const post = (rkey: string) =>
  ({ $type: POST, text: rkey }) satisfies CborValue;

/** A create frame carrying a post, or the record given. */
const createFrame = (params: {
  readonly time: number;
  readonly rkey: string;
  readonly record?: CborValue;
}) =>
  ({
    did: DID,
    time_us: params.time,
    collection: POST,
    rkey: params.rkey,
    operation: 'create',
    record: params.record ?? post(params.rkey),
  }) satisfies IndexFrame;

/** Run one scenario against a fresh store. */
const withStore = <A>(
  use: (store: CanonicalStoreShape) => Effect.Effect<A, LiveIngestError>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CanonicalStore;
      return yield* use(store);
    }).pipe(Effect.provide(canonicalStoreLayer)),
  );

describe('ingestCanonical', () => {
  it('applies frames in order and returns the last time_us as the cursor', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        const outcome = yield* ingestCanonical({
          store,
          frames: Stream.fromIterable([
            createFrame({ time: 100, rkey: 'a' }),
            createFrame({ time: 200, rkey: 'b' }),
            createFrame({ time: 300, rkey: 'c' }),
          ]),
        });

        return {
          outcome,
          size: yield* store.size,
          found: yield* store.get(recordPath('b')),
        };
      }),
    );

    expect(result.outcome).toEqual({ cursor: 300n, applied: 3 });
    expect(result.size).toBe(3);
    expect(result.found?.value).toEqual(post('b'));
  });

  it('ignores a frame at or below the cursor and writes nothing', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        const first = [
          createFrame({ time: 100, rkey: 'a' }),
          createFrame({ time: 200, rkey: 'b' }),
          createFrame({ time: 300, rkey: 'c' }),
        ];
        yield* ingestCanonical({ store, frames: Stream.fromIterable(first) });

        // Reconnect: every frame is at or below the cursor reached, so the rule
        // ignores each one and the store is untouched.
        const replayed = yield* ingestCanonical({
          store,
          frames: Stream.fromIterable(first),
          cursor: 300n,
        });

        return { replayed, size: yield* store.size };
      }),
    );

    expect(result.replayed).toEqual({ cursor: 300n, applied: 0 });
    expect(result.size).toBe(3);
  });

  it('removes the record a delete frame names', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* ingestCanonical({
          store,
          frames: Stream.fromIterable([createFrame({ time: 100, rkey: 'a' })]),
        });
        const before = yield* store.size;

        const deleted = yield* ingestCanonical({
          store,
          frames: Stream.fromIterable([
            {
              did: DID,
              time_us: 200,
              collection: POST,
              rkey: 'a',
              operation: 'delete',
              record: undefined,
            } satisfies IndexFrame,
          ]),
        });

        return {
          before,
          deleted,
          after: yield* store.size,
          gone: yield* store.get(recordPath('a')),
        };
      }),
    );

    expect(result.before).toBe(1);
    expect(result.deleted).toEqual({ cursor: 200n, applied: 1 });
    expect(result.after).toBe(0);
    expect(result.gone).toBeUndefined();
  });

  it('keeps a delete: a stale frame cannot bring the record back', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        const create = [createFrame({ time: 100, rkey: 'a' })];
        yield* ingestCanonical({ store, frames: Stream.fromIterable(create) });
        const deleted = yield* ingestCanonical({
          store,
          frames: Stream.fromIterable([
            {
              did: DID,
              time_us: 200,
              collection: POST,
              rkey: 'a',
              operation: 'delete',
              record: undefined,
            } satisfies IndexFrame,
          ]),
        });
        // A reconnect replays the create, which is at or below the cursor: the
        // rule ignores it, so the delete stands rather than the record returning.
        const replayed = yield* ingestCanonical({
          store,
          frames: Stream.fromIterable(create),
          cursor: 200n,
        });

        return {
          deleted,
          replayed,
          size: yield* store.size,
          gone: yield* store.get(recordPath('a')),
        };
      }),
    );

    expect(result.deleted).toEqual({ cursor: 200n, applied: 1 });
    expect(result.replayed).toEqual({ cursor: 200n, applied: 0 });
    expect(result.size).toBe(0);
    expect(result.gone).toBeUndefined();
  });
});

describe('applyFrame', () => {
  it('writes a record for a collection the store does not special-case', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* applyFrame({
          store,
          frame: {
            did: DID,
            time_us: 100,
            collection: 'com.example.unknown',
            rkey: 'a',
            operation: 'create',
            record: { $type: 'com.example.unknown', note: 'kept' },
          } satisfies IndexFrame,
        });

        return {
          size: yield* store.size,
          found: yield* store.get('at://did:plc:genesis/com.example.unknown/a'),
        };
      }),
    );

    expect(result.size).toBe(1);
    expect(result.found?.value).toEqual({
      $type: 'com.example.unknown',
      note: 'kept',
    });
  });
});
