# @eoa/xrpc-server

Effect-based XRPC server for AT Protocol services with structured error handling and functional programming patterns.

## Installation

```bash
bun add @eoa/xrpc-server
```

## Features

- **Effect Integration**: Full Effect-TS integration with structured concurrency and error handling
- **HTTP Server**: Built on Node.js HTTP server with proper resource management
- **Method Handlers**: Type-safe method registration with Effect-based handlers
- **Authentication**: Extensible authentication system
- **Error Handling**: Comprehensive error handling with proper HTTP responses
- **Streaming Support**: WebSocket streaming capabilities (planned)

## Usage

```typescript
import { createXrpcServer } from '@eoa/xrpc-server';
import { Effect } from 'effect';

// Create server
const server = createXrpcServer();

// Register a method
server.method(
  'com.example.ping',
  {}, // method config
  async (ctx) => {
    return { message: 'pong', timestamp: new Date().toISOString() };
  },
);

// Start server
await Effect.runPromise(server.start({ port: 3000 }));
```

### With Authentication

```typescript
server.method(
  'com.example.protected',
  {
    auth: async ({ req, params }) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) throw new Error('No token provided');

      // Validate token and return auth info
      return { did: 'did:example:user', type: 'user' as const };
    },
  },
  async (ctx) => {
    return { user: ctx.auth!.credentials.did, data: 'protected content' };
  },
);
```

### Error Handling

```typescript
server.method('com.example.failing', {}, async (ctx) => {
  // This will automatically be converted to a proper HTTP error response
  throw new Error('Something went wrong');
});
```

## API

### Server Creation

- `createXrpcServer(lexicons?)` - Create an XRPC server instance

### Method Registration

- `server.method(nsid, config, handler)` - Register an XRPC method
- `server.stream(nsid, config, handler)` - Register a streaming method (future)

### Server Control

- `server.start(config?)` - Start the HTTP server

### Configuration Options

```typescript
interface ServerConfig {
  port?: number; // Server port (default: 3000)
  hostname?: string; // Server hostname (default: "localhost")
  validateResponse?: boolean; // Enable response validation
  errorHandler?: (error: Error) => Effect.Effect<Response, never>; // Custom error handler
  middleware?: Middleware[]; // Request middleware
}
```

### Method Configuration

```typescript
interface MethodConfig<A> {
  auth?: AuthVerifier<A>; // Authentication function
  rateLimit?: RateLimitConfig; // Rate limiting settings
  validateInput?: boolean; // Enable input validation
  validateOutput?: boolean; // Enable output validation
}
```

## Handler Context

Method handlers receive a context object with:

```typescript
interface HandlerContext<I> {
  params: Record<string, unknown>; // Query parameters
  input?: I; // Request body (parsed JSON)
  auth?: AuthInfo; // Authentication information
  headers: Record<string, string>; // HTTP headers
}
```

## Authentication

Authentication verifiers are functions that:

1. Receive request context and parameters
2. Return authentication information or throw an error
3. Are executed before the main handler

```typescript
type AuthVerifier<A> = (ctx: {
  req: Request;
  params: Record<string, unknown>;
}) => Effect.Effect<A, Error>;
```

## Error Responses

Errors thrown in handlers are automatically converted to proper HTTP responses:

- **400 Bad Request**: Validation errors, malformed requests
- **401 Unauthorized**: Authentication failures
- **403 Forbidden**: Authorization failures
- **404 Not Found**: Unknown methods
- **429 Too Many Requests**: Rate limit exceeded
- **500 Internal Server Error**: Unexpected errors

## Effect Integration

The server is designed to work seamlessly with Effect-TS patterns:

```typescript
import { Effect, Schedule } from 'effect';

// Handlers can use full Effect capabilities
server.method('com.example.effectful', {}, (ctx) =>
  Effect.gen(function* () {
    const data = yield* someEffectfulOperation();

    // Automatic error handling and resource management
    yield* Effect.sleep(100);

    return { result: data };
  }),
);

// Server startup with proper lifecycle management
const program = Effect.gen(function* () {
  yield* server.start({ port: 3000 });
});

Effect.runPromise(program);
```

## License

MIT
