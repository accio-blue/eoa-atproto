import {
  CommitHandler,
  FirehoseError,
  FirehoseEvent,
  FirehoseEventHandler,
  FirehoseOptions,
  FirehoseSubscription,
  IdentityHandler,
} from './types.js';
import { XrpcClient, createXrpcClient } from '@eoa/xrpc';
import { Effect } from 'effect';

// Simple firehose subscription implementation
export class SimpleFirehoseSubscription implements FirehoseSubscription {
  private active = false;
  private cursor: string | undefined;

  constructor(
    private readonly xrpcClient: XrpcClient,
    private readonly options: FirehoseOptions,
    private readonly handlers: {
      onCommit?: CommitHandler;
      onIdentity?: IdentityHandler;
      onEvent?: FirehoseEventHandler;
    } = {},
  ) {}

  start(): Effect.Effect<never, Error> {
    const self = this;
    self.active = true;

    // Simplified firehose implementation - in practice this would use WebSockets
    // or Server-Sent Events for real-time streaming
    return Effect.forever(
      Effect.gen(function* () {
        if (!self.active) {
          return yield* Effect.fail(new Error('Subscription stopped'));
        }

        try {
          // Placeholder for real firehose implementation
          // This would call the actual firehose endpoint
          yield* Effect.sleep(1000); // Simulate polling
        } catch (error) {
          yield* Effect.logError(`Firehose error: ${error}`);
          yield* Effect.sleep(5000); // Retry delay
        }
      }),
    );
  }

  stop(): Effect.Effect<void, Error> {
    this.active = false;
    return Effect.void;
  }

  isActive(): boolean {
    return this.active;
  }

  getCursor(): string | undefined {
    return this.cursor;
  }

  setCursor(cursor: string): void {
    this.cursor = cursor;
  }
}

// Create a firehose subscription
export const createFirehoseSubscription = (
  serviceUrl: string,
  options: FirehoseOptions = {},
  handlers: {
    onCommit?: CommitHandler;
    onIdentity?: IdentityHandler;
    onEvent?: FirehoseEventHandler;
  } = {},
): Effect.Effect<FirehoseSubscription, Error> => {
  return Effect.gen(function* () {
    const xrpcClient = createXrpcClient({
      service: serviceUrl,
    });

    return new SimpleFirehoseSubscription(xrpcClient, options, handlers);
  });
};

// High-level firehose consumer
export const consumeFirehose = (
  serviceUrl: string,
  options: FirehoseOptions = {},
  consumer: (event: FirehoseEvent) => Effect.Effect<void, Error>,
): Effect.Effect<never, Error> => {
  return Effect.gen(function* () {
    const subscription = yield* createFirehoseSubscription(
      serviceUrl,
      options,
      {
        onEvent: consumer,
      },
    );

    return yield* subscription.start();
  });
};

// Utility to filter firehose events
export const filterEvents =
  (predicate: (event: FirehoseEvent) => boolean) =>
  (event: FirehoseEvent): Effect.Effect<void, Error> => {
    return predicate(event)
      ? Effect.void
      : Effect.fail(
          new FirehoseError({
            cause: 'Event filtered out',
            operation: 'handle',
          }),
        );
  };

// Filter for specific collections
export const filterCollections = (collections: readonly string[]) =>
  filterEvents((event) => {
    if (!event.commit) return false;
    return event.commit.ops.some((op) =>
      collections.some((col) => op.path.startsWith(`app.bsky.${col}/`)),
    );
  });

// Filter for specific DIDs
export const filterDIDs = (dids: readonly string[]) =>
  filterEvents((event) => dids.includes(event.did));

// Export for backward compatibility
export { SimpleFirehoseSubscription as FirehoseSubscriptionImpl };
