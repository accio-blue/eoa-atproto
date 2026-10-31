import { type CommitEvent, type Firehose } from './firehose.js';
import { Deferred, Effect, Option, Stream } from 'effect';
import {
  SUBSCRIBE_NSID,
  SUBSCRIBE_PATH,
  subscribeReposHandler,
} from './subscribe.js';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createXrpcServer } from '@eoa/xrpc-server';

/**
 * A subscription has to end when the thing that asked for it goes away (the
 * Effect-PDS map, `bbny`). The stream is a fan-out, so a connection that is
 * never torn down is a queue the firehose keeps writing into forever — one per
 * reconnect, in a server whose whole job is to stay up.
 */

/** A firehose whose stream never ends, which is what a live one is. */
const aStreamThatNeverEnds = (onExit: () => void) =>
  ({
    emit: () => Effect.succeed(Option.none<CommitEvent>()),
    emitIdentity: () =>
      Effect.succeed({
        kind: 'identity',
        seq: 0,
        timeUs: 0,
        time: '2026-10-22T00:00:00.000Z',
        did: 'did:plc:test',
      }),
    cursorOf: () => Effect.succeed(0),
    head: Effect.succeed({ seq: 0, timeUs: 0 }),
    subscribe: () =>
      Stream.never.pipe(
        Stream.onExit(() =>
          Effect.sync(() => {
            onExit();
          }),
        ),
      ),
  }) satisfies Firehose['Service'];

describe('the firehose socket', () => {
  it('ends a subscription when its client goes away', async () => {
    const ended = { count: 0 };
    const xrpc = createXrpcServer();
    xrpc.stream(
      SUBSCRIBE_NSID,
      {},
      subscribeReposHandler(
        aStreamThatNeverEnds(() => {
          ended.count += 1;
        }),
      ),
    );

    // The transport and the client live in one scope, so the socket is still
    // there when the client asks for it.
    const whileOpen = await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<number>();
        yield* Effect.forkChild(
          Effect.scoped(
            xrpc.start({ port: 0, hostname: '127.0.0.1' }).pipe(
              Effect.tap((bound) => Deferred.succeed(ready, bound)),
              Effect.andThen(Effect.never),
            ),
          ),
        );
        const bound = yield* Deferred.await(ready);

        const client = yield* Effect.sync(
          () => new WebSocket(`ws://127.0.0.1:${bound}${SUBSCRIBE_PATH}`),
        );
        yield* Effect.tryPromise(
          () =>
            new Promise((resolve, reject) => {
              client.on('open', () => {
                resolve(undefined);
              });
              client.on('error', () => {
                reject(new Error('the socket did not open'));
              });
            }),
        );

        // While the client is there, the subscription is live and has not ended.
        const whileOpen = ended.count;
        yield* Effect.sync(() => {
          client.close();
        });
        return whileOpen;
      }),
    );

    expect(whileOpen).toBe(0);

    // The scope closed, which closed the client — and a subscription that ends
    // is what keeps the firehose from accumulating a queue for every connection
    // that ever happened.
    await expect.poll(() => ended.count, { timeout: 5000 }).toBe(1);
  });
});
