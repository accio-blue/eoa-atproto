import { Effect, Stream } from 'effect';
import { IndexStore, indexStoreLayer } from './index-store.js';
import { LiveIngestError, framesOfEndpoint, ingestFrames } from './live.js';
import { type Server, createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

/**
 * The live side's contract: a fresh stream indexes the references its frames
 * carry and returns the last `time_us`; a resumed stream skips the frames it
 * already applied and leaves the cursor where it was; a delete does not throw;
 * and a malformed NDJSON line is a `LiveIngestError`, not a defect.
 *
 * The store cases run in one provided scenario - one store, one
 * `Effect.provide` - so the cursor assertions see the same index. The malformed
 * line is driven through `framesOfEndpoint` against a real local HTTP server,
 * since the decoder lives on that path.
 */

const targetOf = (name: string) =>
  `at://did:plc:target/app.bsky.feed.post/${name}`;

const SOURCE = 'at://did:plc:genesis/app.bsky.feed.like/a';

/** A create frame whose record links one target. */
const frameThatLinks = (params: {
  readonly time: number;
  readonly rkey: string;
  readonly target: string;
}) => ({
  did: 'did:plc:genesis',
  time_us: params.time,
  collection: 'app.bsky.feed.like',
  rkey: params.rkey,
  operation: 'create',
  record: {
    $type: 'app.bsky.feed.like',
    subject: { uri: params.target },
  },
});

/** A server that answers one request with `body` and closes with the effect. */
const servedOnce = (body: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: Server; readonly port: number }>(
          (resolve, reject) => {
            const server = createServer((_request, response) => {
              response.setHeader('content-type', 'application/x-ndjson');
              response.setHeader('connection', 'close');
              response.end(body);
            });
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
              const address = server.address();
              resolve({
                server,
                port:
                  address === null || typeof address === 'string'
                    ? 0
                    : address.port,
              });
            });
          },
        ),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
  );

describe('ingestFrames', () => {
  it('indexes a fresh stream, skips a resumed past, and tolerates a delete', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* IndexStore;

        const fresh = [
          frameThatLinks({ time: 100, rkey: 'a', target: targetOf('a') }),
          frameThatLinks({ time: 200, rkey: 'b', target: targetOf('b') }),
          frameThatLinks({ time: 300, rkey: 'c', target: targetOf('c') }),
        ];
        const indexed = yield* ingestFrames({
          store,
          frames: Stream.fromIterable(fresh),
        });
        const backlinks = {
          a: yield* store.backlinksOf(targetOf('a')),
          b: yield* store.backlinksOf(targetOf('b')),
          c: yield* store.backlinksOf(targetOf('c')),
        };

        // A reconnect replays with the cursor it reached: every frame is at or
        // below it, so nothing is applied and the cursor does not move.
        const replay = [
          frameThatLinks({ time: 400, rkey: 'd', target: targetOf('d') }),
          frameThatLinks({ time: 500, rkey: 'e', target: targetOf('e') }),
          frameThatLinks({ time: 600, rkey: 'f', target: targetOf('f') }),
        ];
        const resumed = yield* ingestFrames({
          store,
          frames: Stream.fromIterable(replay),
          cursor: 600,
        });
        const skipped = yield* store.backlinksOf(targetOf('d'));

        // A delete carries no record, so its targets come from the store's own reverse index --
        // and the frame is still applied and advances the cursor.
        const deleted = yield* ingestFrames({
          store,
          frames: Stream.fromIterable([
            {
              did: 'did:plc:genesis',
              time_us: 700,
              collection: 'app.bsky.feed.like',
              rkey: 'a',
              operation: 'delete',
              record: undefined,
            },
          ]),
          cursor: 600,
        });
        const afterDelete = yield* store.backlinksOf(targetOf('a'));

        return { indexed, backlinks, resumed, skipped, deleted, afterDelete };
      }).pipe(Effect.provide(indexStoreLayer)),
    );

    expect(result.indexed).toEqual({ cursor: 300, indexed: 3 });
    expect(result.backlinks).toEqual({
      a: [SOURCE],
      b: ['at://did:plc:genesis/app.bsky.feed.like/b'],
      c: ['at://did:plc:genesis/app.bsky.feed.like/c'],
    });
    expect(result.resumed).toEqual({ cursor: 600, indexed: 0 });
    expect(result.skipped).toEqual([]);
    expect(result.deleted).toEqual({ cursor: 700, indexed: 1 });
    // The backlink went with the record: a delete names no target, the store remembers them.
    expect(result.afterDelete).toEqual([]);
  });
});

describe('framesOfEndpoint', () => {
  it('reports a malformed NDJSON line as a LiveIngestError', async () => {
    const validFrame =
      '{"did":"did:plc:genesis","time_us":1,"kind":"commit","commit":{"operation":"create","collection":"app.bsky.feed.like","rkey":"a","record":{}}}';

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { port } = yield* servedOnce(`${validFrame}\nnot json`);
        return yield* framesOfEndpoint({
          url: `http://127.0.0.1:${port}/subscribe`,
        }).pipe(Stream.runCollect, Effect.flip);
      }).pipe(Effect.scoped),
    );

    expect(error).toBeInstanceOf(LiveIngestError);
  });
});
