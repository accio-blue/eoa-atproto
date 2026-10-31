# @eoa/crypto

Effect-based cryptographic operations for AT Protocol including key generation, signing, verification, and DID key management.

## Installation

```bash
bun add @eoa/crypto
```

## Features

- **Key Generation**: Create ES256 and ES256K (secp256k1) key pairs
- **Cryptographic Signing**: Sign and verify data with ECDSA
- **DID Key Support**: Generate and resolve did:key identifiers
- **Web Crypto API**: Built on modern Web Crypto API with Effect integration
- **Type Safety**: Full TypeScript support with branded types

## Usage

### Key Generation

```typescript
import { generateES256KeyPair } from '@eoa/crypto';
import { Effect } from 'effect';

// Generate a new ES256 key pair
const keyPair = await Effect.runPromise(generateES256KeyPair());

console.log('Private key:', keyPair.privateKey);
console.log('Public key:', keyPair.publicKey);
```

### Signing and Verification

```typescript
import { sign, verify } from '@eoa/crypto';

// Sign some data
const data = new TextEncoder().encode('Hello, AT Protocol!');
const signature = await Effect.runPromise(sign(keyPair.privateKey, data));

// Verify the signature
const isValid = await Effect.runPromise(
  verify(keyPair.publicKey, data, signature),
);
console.log('Signature valid:', isValid); // true
```

### DID Key Operations

```typescript
import { createDIDKey, createDIDDocument } from '@eoa/crypto';

// Create a DID:key from a public key
const did = await Effect.runPromise(createDIDKey(keyPair.publicKey));
console.log('DID:', did); // did:key:z...

// Create a DID document
const document = await Effect.runPromise(createDIDDocument(keyPair.publicKey));
console.log('DID Document:', document);
```

### Key Import/Export

```typescript
import { exportPrivateKey, importPrivateKey } from '@eoa/crypto';

// Export private key as JWK
const jwk = await Effect.runPromise(exportPrivateKey(keyPair.privateKey));

// Import private key from JWK
const importedKey = await Effect.runPromise(importPrivateKey(jwk));
```

## Key Types

### ES256 (P-256)

- Recommended for most AT Protocol applications
- Widely supported in Web Crypto API
- Used for did:key with `z2` prefix

### ES256K (secp256k1)

- Compatible with Bitcoin/Ethereum ecosystems
- Requires external cryptographic library
- Used for did:key with `z3` prefix

## DID Key Format

DID keys are generated according to the [did:key specification](https://w3c-ccg.github.io/did-method-key/):

```
did:key:z{prefix}{thumbprint}
```

Where:

- `prefix`: `2` for ES256, `3` for ES256K
- `thumbprint`: Base58-encoded SHA-256 hash of the public key

## Cryptographic Operations

### Signing Algorithm

- **Algorithm**: ECDSA
- **Curve**: P-256 (ES256) or secp256k1 (ES256K)
- **Hash**: SHA-256

### Key Formats

- **JWK**: JSON Web Key format for import/export
- **Raw**: Binary key material for cryptographic operations

## Error Handling

All cryptographic operations return structured errors:

```typescript
import { CryptoError } from '@eoa/crypto';

try {
  const result = await Effect.runPromise(someCryptoOperation());
} catch (error) {
  if (error instanceof CryptoError) {
    console.log('Operation:', error.options.operation);
    console.log('Cause:', error.options.cause);
  }
}
```

## Security Considerations

- **Key Storage**: Never store private keys in plain text
- **Key Rotation**: Regularly rotate cryptographic keys
- **Secure Random**: Uses cryptographically secure random number generation
- **Web Crypto**: Operations run in secure contexts (HTTPS/localhost)

## Browser Support

Requires a secure context (HTTPS or localhost) for Web Crypto API access.

## License

MIT
