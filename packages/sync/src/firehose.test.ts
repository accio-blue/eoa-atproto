import { Effect, Fiber } from 'effect';
import {
  FirehoseSubscriptionImpl,
  SimpleFirehoseSubscription,
  consumeFirehose,
  createFirehoseSubscription,
  filterCollections,
  filterDIDs,
  filterEvents,
} from './firehose.js';
import { describe, expect, it } from 'vitest';
import type { DID } from '@eoa/core';
import { FirehoseError } from './types.js';
import type { FirehoseEvent } from './types.js';
import type { XrpcClient } from '@eoa/xrpc';

const DID_VALUE = 'did:plc:test' as DID;
const OTHER_DID = 'did:plc:other' as DID;

// The subscription under test never calls the XRPC client, so a client that
// can never succeed is enough to exercise the subscription lifecycle.
const unusedClient: XrpcClient = {
  call: () => Effect.never,
};

const makeEvent = (): FirehoseEvent => ({
  $type: 'com.atproto.sync.subscribeRepos#commit',
  time_us: 1,
  did: DID_VALUE,
  commit: {
    rev: 'rev-1',
    blocks: new Uint8Array(),
    ops: [{ action: 'create', path: 'app.bsky.feed.post/abc' }],
    time: '2026-01-01T00:00:00.000Z',
  },
});

const runFailure = async <A>(
  effect: Effect.Effect<A, Error>,
): Promise<Error> => {
  try {
    await Effect.runPromise(effect);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Expected an Error rejection, received ${String(error)}`);
  }
  throw new Error('Expected the effect to fail');
};

describe('SimpleFirehoseSubscription', () => {
  it('is inactive with no cursor before it starts', () => {
    const subscription = new SimpleFirehoseSubscription(unusedClient, {});

    expect(subscription.isActive()).toBe(false);
    expect(subscription.getCursor()).toBeUndefined();
  });

  it('becomes active synchronously when start is invoked', async () => {
    const subscription = new SimpleFirehoseSubscription(unusedClient, {});
    const program = subscription.start();

    expect(Effect.isEffect(program)).toBe(true);
    expect(subscription.isActive()).toBe(true);

    await Effect.runPromise(subscription.stop());
    expect(subscription.isActive()).toBe(false);
  });

  it('tracks the cursor via setCursor and getCursor', () => {
    const subscription = new SimpleFirehoseSubscription(unusedClient, {});

    subscription.setCursor('cursor-1');
    expect(subscription.getCursor()).toBe('cursor-1');

    subscription.setCursor('cursor-2');
    expect(subscription.getCursor()).toBe('cursor-2');
  });

  it('does not seed the cursor from the options', () => {
    const subscription = new SimpleFirehoseSubscription(unusedClient, {
      cursor: 'resume-from',
    });

    expect(subscription.getCursor()).toBeUndefined();
  });

  it('fails the running loop on the poll after stop', async () => {
    const subscription = new SimpleFirehoseSubscription(unusedClient, {});
    const fiber = Effect.runFork(subscription.start());

    await Effect.runPromise(subscription.stop());

    const error = await Effect.runPromise(Effect.flip(Fiber.join(fiber)));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Subscription stopped');
  });

  it('accepts commit, identity and event handlers', () => {
    const subscription = new SimpleFirehoseSubscription(
      unusedClient,
      {},
      {
        onCommit: () => Effect.void,
        onIdentity: () => Effect.void,
        onEvent: () => Effect.void,
      },
    );

    expect(subscription.isActive()).toBe(false);
  });
});

describe('createFirehoseSubscription', () => {
  it('builds a subscription from a service URL, options and handlers', async () => {
    const subscription = await Effect.runPromise(
      createFirehoseSubscription(
        'https://pds.test',
        { cursor: 'resume', backfill: true },
        { onCommit: () => Effect.void },
      ),
    );

    expect(subscription).toBeInstanceOf(SimpleFirehoseSubscription);
    expect(subscription.isActive()).toBe(false);
    expect(subscription.getCursor()).toBeUndefined();
  });
});

describe('consumeFirehose', () => {
  it('returns a long-running effect that can be interrupted', async () => {
    const program = consumeFirehose('https://pds.test', {}, () => Effect.void);

    expect(Effect.isEffect(program)).toBe(true);

    const fiber = Effect.runFork(program);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });
});

describe('filterEvents', () => {
  it('forwards the event to the predicate', async () => {
    const seen: string[] = [];
    const handler = filterEvents((event) => {
      seen.push(event.did);
      return true;
    });

    await Effect.runPromise(handler(makeEvent()));

    expect(seen).toEqual([DID_VALUE]);
  });

  it('succeeds when the predicate accepts the event', async () => {
    const handler = filterEvents(() => true);

    await expect(
      Effect.runPromise(handler(makeEvent())),
    ).resolves.toBeUndefined();
  });

  it('fails with a FirehoseError when the predicate rejects the event', async () => {
    const handler = filterEvents(() => false);
    const error = await runFailure(handler(makeEvent()));

    expect(error).toBeInstanceOf(FirehoseError);
    if (!(error instanceof FirehoseError)) {
      return;
    }
    expect(error.options.operation).toBe('handle');
    expect(error.options.cause).toBe('Event filtered out');
  });
});

describe('filterCollections', () => {
  it('accepts events whose commit touches a matching collection', async () => {
    const handler = filterCollections(['feed.post']);

    await expect(
      Effect.runPromise(handler(makeEvent())),
    ).resolves.toBeUndefined();
  });

  it('rejects events that touch no matching collection', async () => {
    const handler = filterCollections(['feed.repost']);
    const error = await runFailure(handler(makeEvent()));

    expect(error).toBeInstanceOf(FirehoseError);
  });

  it('rejects events without a commit', async () => {
    const handler = filterCollections(['feed.post']);
    const event: FirehoseEvent = {
      $type: 'com.atproto.sync.subscribeRepos#identity',
      time_us: 2,
      did: DID_VALUE,
    };
    const error = await runFailure(handler(event));

    expect(error).toBeInstanceOf(FirehoseError);
  });
});

describe('filterDIDs', () => {
  it('accepts events from a listed did', async () => {
    const handler = filterDIDs([DID_VALUE]);

    await expect(
      Effect.runPromise(handler(makeEvent())),
    ).resolves.toBeUndefined();
  });

  it('rejects events from a did that is not listed', async () => {
    const handler = filterDIDs([OTHER_DID]);
    const error = await runFailure(handler(makeEvent()));

    expect(error).toBeInstanceOf(FirehoseError);
  });
});

describe('FirehoseSubscriptionImpl', () => {
  it('is an alias for SimpleFirehoseSubscription', () => {
    expect(FirehoseSubscriptionImpl).toBe(SimpleFirehoseSubscription);
  });
});
