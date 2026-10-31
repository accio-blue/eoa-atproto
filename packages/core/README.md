# @eoa/core

Core utilities and types for Effect-TS AT Protocol packages.

## Installation

```bash
bun add @eoa/core
```

## Features

- **AT Protocol Types**: Strongly typed DID, Handle, NSID, ATURI, and TID types with validation
- **Effect-based Errors**: Structured error handling with specific error types for XRPC operations
- **Retry Policies**: Built-in exponential backoff and retry logic for network operations
- **Resource Management**: Utilities for managing resources with proper cleanup
- **Utility Functions**: Common helpers for URL building, header management, and timeouts

## Usage

```typescript
import { DID, ATURI, createXRPCError, exponentialBackoff } from '@eoa/core';
import { Effect } from 'effect';

// Type-safe AT Protocol identifiers
const did: DID = DID.make('did:plc:example123');
const uri: ATURI = ATURI.make('at://user.bsky.social/app.bsky.feed.post/123');

// Structured error handling
const error = createXRPCError(404, 'Post not found');

// Retry policies for network operations
const retryEffect = Effect.retry(myApiCall, exponentialBackoff);
```

## Error Types

- `XRPCError` - Base error for XRPC operations
- `XRPCInvalidResponseError` - Schema validation failures
- `AuthenticationRequiredError` - 401 errors
- `ForbiddenError` - 403 errors
- `NotFoundError` - 404 errors
- `RateLimitExceededError` - 429 errors
- `NetworkError` - Network connectivity issues
- `TimeoutError` - Operation timeouts

## License

MIT
