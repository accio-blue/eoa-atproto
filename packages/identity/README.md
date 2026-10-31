# @eoa/identity

Effect-based decentralized identity resolution for AT Protocol including DID and handle resolution with caching support.

## Installation

```bash
bun add @eoa/identity
```

## Features

- **DID Resolution**: Resolve did:key and other DID methods to DID documents
- **Handle Resolution**: Resolve social handles to DIDs and service endpoints
- **Identity Resolution**: Unified resolution for both DIDs and handles
- **Caching Support**: Built-in caching for performance optimization
- **Effect Integration**: Full Effect-TS integration with structured error handling

## Usage

### Basic Identity Resolution

```typescript
import { resolveIdentity, resolveDID, resolveHandle } from '@eoa/identity';
import { Effect } from 'effect';

// Resolve any identifier (DID or handle)
const identity = await Effect.runPromise(
  resolveIdentity('did:key:z6Mkexample'),
);

// Resolve specific types
const didResolution = await Effect.runPromise(
  resolveDID('did:key:z6Mkexample'),
);

const handleResolution = await Effect.runPromise(
  resolveHandle('user.bsky.social'),
);
```

### Custom Resolver

```typescript
import { DefaultIdentityResolver } from '@eoa/identity';

const resolver = new DefaultIdentityResolver();

const identity = await Effect.runPromise(
  resolver.resolveIdentity('user.bsky.social'),
);
```

## Resolution Results

### Identity Resolution

```typescript
interface IdentityResolution {
  did: DID; // The resolved DID
  handle?: Handle; // Associated handle (if available)
  didDocument: DIDDocument; // Full DID document
  alsoKnownAs?: string[]; // Alternative identifiers
  services?: Service[]; // Service endpoints
}
```

### Handle Resolution

```typescript
interface HandleResolution {
  handle: Handle; // The resolved handle
  did: DID; // Associated DID
  alsoKnownAs?: string[]; // Alternative identifiers
}
```

## Error Handling

Identity resolution can fail with specific error types:

```typescript
import {
  IdentityError,
  DIDNotFoundError,
  HandleNotFoundError,
} from '@eoa/identity';

try {
  const result = await Effect.runPromise(resolveIdentity('invalid.identifier'));
} catch (error) {
  if (error instanceof DIDNotFoundError) {
    console.log('DID not found:', error.identifier);
  } else if (error instanceof HandleNotFoundError) {
    console.log('Handle not found:', error.identifier);
  }
}
```

## Caching

The package includes built-in caching support:

```typescript
import { globalCache, withCache } from '@eoa/identity';

// Use global cache instance
const cachedResolver = withCache(defaultResolver, 10 * 60 * 1000); // 10 minutes TTL

// Or manage cache manually
globalCache.clear(); // Clear all cached entries
```

## Supported DID Methods

- **did:key**: Local key-based DIDs (fully supported)
- **did:plc**: AT Protocol PLC DIDs (placeholder implementation)
- **did:web**: Web-based DIDs (extensible for future support)

## Supported Handle Formats

- **username.domain**: Standard social handles (e.g., `user.bsky.social`)
- **Custom domains**: Any domain with proper DNS configuration

## Effect Integration

All operations return Effect computations for proper error handling and resource management:

```typescript
// Sequential resolution
const identities = await Effect.runPromise(
  Effect.forEach(['user1.bsky.social', 'user2.bsky.social'], resolveIdentity),
);

// Parallel resolution with concurrency control
const identities = await Effect.runPromise(
  Effect.forEach(userList, resolveIdentity, { concurrency: 5 }),
);
```

## Implementation Notes

This is a foundational implementation that provides:

- Basic did:key resolution
- Simulated handle-to-DID mapping
- In-memory caching
- Structured error handling

For production use, you may want to:

- Add external DID resolver services
- Implement persistent caching (Redis, etc.)
- Add rate limiting for external services
- Extend support for additional DID methods

## License

MIT
