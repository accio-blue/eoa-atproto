# @eoa/lexicon

Effect Schema integration for AT Protocol lexicons with runtime validation and type safety.

## Installation

```bash
bun add @eoa/lexicon
```

## Features

- **Lexicon Registry**: Manage multiple AT Protocol lexicon documents
- **Effect Schema Integration**: Convert lexicon definitions to Effect Schemas for validation
- **Runtime Validation**: Validate XRPC parameters, inputs, and outputs against lexicons
- **Type Safety**: TypeScript types derived from lexicon schemas
- **Error Handling**: Structured validation errors with Effect's error system

## Usage

```typescript
import { Lexicons, createLexicons, assertValidXrpcParams } from '@eoa/lexicon';
import { Effect } from 'effect';

// Create lexicon registry
const lexicons = createLexicons([
  {
    lexicon: 1,
    id: 'com.example.ping',
    defs: {
      main: {
        type: 'query',
        description: 'Ping the server',
        parameters: {
          type: 'params',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    },
  },
]);

// Validate XRPC parameters
const validatedParams = await Effect.runPromise(
  assertValidXrpcParams({
    params: { message: 'hello' },
    lexicons,
    nsid: 'com.example.ping',
  }),
);
```

## API

### Lexicon Management

- `createLexicons(docs)` - Create a lexicon registry
- `Lexicons` class - Manage lexicon documents

### Validation

- `assertValidXrpcParams({ params, lexicons, nsid, method? })` - Validate query parameters
- `assertValidXrpcInput({ input, lexicons, nsid, method? })` - Validate request input
- `assertValidXrpcOutput({ output, lexicons, nsid, method? })` - Validate response output

### Schemas

Common AT Protocol schemas:

- `BlobSchema` - Binary data with MIME type and size
- `CIDSchema` - Content identifier validation
- `DateTimeSchema` - ISO 8601 timestamp validation
- `RecordSchema` - Base schema for AT Protocol records

## Error Handling

Validation errors are returned as `XRPCInvalidResponseError` with detailed validation messages and HTTP 400 status codes.

## License

MIT
