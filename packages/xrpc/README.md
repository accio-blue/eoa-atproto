# @eoa/xrpc

Effect-based XRPC client for AT Protocol services with structured error handling and functional programming patterns.

## Installation

```bash
bun add @eoa/xrpc
```

## Features

- **Effect Integration**: Full Effect-TS integration with structured concurrency and error handling
- **Type Safety**: Strongly typed XRPC calls with automatic error inference
- **Flexible Configuration**: Configurable service URLs, headers, and request options
- **Error Handling**: Comprehensive error handling with specific error types for different failure modes
- **Retry & Timeout**: Built-in support for retries, timeouts, and circuit breaking through Effect policies

## Usage

```typescript
import { createXrpcClient } from '@eoa/xrpc';
import { Effect } from 'effect';

// Create a client
const client = createXrpcClient({
  service: 'https://api.bsky.app',
});

// Make XRPC calls
const result = await Effect.runPromise(
  client.call('com.atproto.server.describeServer'),
);

console.log(result.body); // Server description
```

### With Authentication

```typescript
const authenticatedClient = createXrpcClient({
  service: 'https://api.bsky.app',
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});

const profile = await Effect.runPromise(
  authenticatedClient.call('com.atproto.repo.getRecord', {
    repo: 'did:plc:example',
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
  }),
);
```

### Error Handling

```typescript
const result = await Effect.runPromise(
  Effect.either(client.call('some.method')),
);

if (result._tag === 'Left') {
  // Handle different error types
  switch (result.left._tag) {
    case 'AuthenticationRequiredError':
      // Handle auth errors
      break;
    case 'RateLimitExceededError':
      // Handle rate limiting
      break;
    default:
      // Handle other errors
      break;
  }
} else {
  // Success case
  console.log(result.right.body);
}
```

## API

### Client Creation

- `createXrpcClient(config)` - Create an XRPC client with configuration

### Client Methods

- `client.call(nsid, params?, data?, options?)` - Make an XRPC call

### Configuration Options

```typescript
interface ClientConfig {
  service?: string | ((nsid: string) => string); // Service URL
  headers?: Record<string, string | ((nsid: string) => string)>; // Default headers
}
```

### Call Options

```typescript
interface CallOptions {
  encoding?: string; // Content-Type override
  headers?: Record<string, string>; // Per-request headers
  timeout?: number; // Request timeout in milliseconds
}
```

## Error Types

- `XRPCError` - Base XRPC error
- `AuthenticationRequiredError` - 401 errors
- `ForbiddenError` - 403 errors
- `NotFoundError` - 404 errors
- `RateLimitExceededError` - 429 errors
- `InternalServerError` - 500 errors

## Integration with Effect

The client is designed to work seamlessly with Effect-TS patterns:

```typescript
import { Effect, Schedule } from 'effect';

// With retry policy
const callWithRetry = client
  .call('some.method')
  .pipe(Effect.retry(Schedule.exponential(100).pipe(Schedule.upTo(30000))));

// With timeout
const callWithTimeout = client.call('some.method').pipe(Effect.timeout(5000));

// Combined
const robustCall = Effect.retry(
  Effect.timeout(client.call('some.method'), 5000),
  Schedule.exponential(100),
);
```

## License

MIT
