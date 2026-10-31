# @eoa/sync

Effect-based data synchronization and firehose subscriptions for AT Protocol repositories.

## Installation

```bash
bun add @eoa/sync
```

## Features

- **Firehose Subscriptions**: Real-time event streaming from AT Protocol repositories
- **Repository Sync**: Download and synchronize repository data
- **Event Filtering**: Filter events by collection, DID, or operation type
- **Concurrent Processing**: Safe parallel processing of sync operations
- **Error Handling**: Structured error handling with specific sync failure types

## Usage

### Firehose Subscription

```typescript
import { createFirehoseSubscription, consumeFirehose } from '@eoa/sync';
import { Effect } from 'effect';

// Create a firehose subscription
const subscription = await Effect.runPromise(
  createFirehoseSubscription(
    'https://api.bsky.app',
    {
      filter: { collections: ['app.bsky.feed.post'] },
    },
    {
      onCommit: (event) =>
        Effect.gen(function* () {
          console.log('New commit:', event.commit?.ops.length, 'operations');
          // Process commit operations
        }),
    },
  ),
);

// Start the subscription
await Effect.runPromise(subscription.start());
```

### Repository Synchronization

```typescript
import { syncRepository, createSyncClient } from '@eoa/sync';

// Sync a specific repository
const result = await Effect.runPromise(
  syncRepository('https://api.bsky.app', {
    did: 'did:plc:example123',
    collections: ['app.bsky.feed.post'],
  }),
);

console.log(`Synced ${result.processed} records for ${result.did}`);
```

### Event Filtering

```typescript
import { filterCollections, filterDIDs } from '@eoa/sync';

// Filter for specific collections
const collectionFilter = filterCollections([
  'app.bsky.feed.post',
  'app.bsky.feed.like',
]);

// Filter for specific DIDs
const didFilter = filterDIDs(['did:plc:user1', 'did:plc:user2']);

// Use in firehose consumer
await Effect.runPromise(
  consumeFirehose('https://api.bsky.app', {}, collectionFilter),
);
```

## API

### Firehose

- `createFirehoseSubscription(serviceUrl, options, handlers)` - Create subscription
- `consumeFirehose(serviceUrl, options, consumer)` - High-level consumer
- `filterCollections(collections)` - Filter by collection NSIDs
- `filterDIDs(dids)` - Filter by repository DIDs

### Synchronization

- `createSyncClient(serviceUrl)` - Create sync client
- `syncRepository(serviceUrl, operation)` - Sync single repository
- `syncRepositories(serviceUrl, operations)` - Sync multiple repositories

### Types

#### FirehoseEvent

```typescript
interface FirehoseEvent {
  $type: string;
  time_us: number;
  did: string;
  commit?: RepoCommit;
  identity?: IdentityEvent;
}
```

#### RepoSyncOperation

```typescript
interface RepoSyncOperation {
  did: string;
  from?: string; // Start revision
  to?: string; // End revision
  collections?: string[]; // Limit to collections
}
```

## Event Types

### Repository Commits

- **Create**: New records added
- **Update**: Existing records modified
- **Delete**: Records removed

### Identity Events

- **Create**: New identity created
- **Update**: Identity information changed
- **Delete**: Identity deactivated

## Performance Considerations

- **Backpressure**: Firehose subscriptions include built-in backpressure handling
- **Concurrency**: Sync operations support configurable concurrency limits
- **Filtering**: Apply filters early to reduce processing overhead
- **Caching**: Consider caching frequently accessed repository data

## Error Handling

```typescript
import { FirehoseError, SyncError } from '@eoa/sync';

try {
  const result = await Effect.runPromise(syncOperation);
} catch (error) {
  if (error instanceof FirehoseError) {
    console.log('Firehose error:', error.options.operation);
  } else if (error instanceof SyncError) {
    console.log('Sync error for', error.options.did);
  }
}
```

## Implementation Notes

This package provides a foundation for AT Protocol synchronization:

- **Firehose**: Currently uses polling; real implementations use WebSockets
- **Sync**: Basic repository sync; can be extended for full CAR file processing
- **Filtering**: Efficient event filtering to reduce processing load
- **Concurrency**: Safe parallel processing with Effect's structured concurrency

For production use, consider:

- WebSocket connections for real-time firehose
- Incremental sync with proper diffing
- Repository state persistence
- Rate limiting and backoff strategies

## License

MIT
