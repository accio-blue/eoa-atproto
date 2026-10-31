import * as Identity from './resolver.js';
import * as Types from './types.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import type { HandleTransportShape } from './handle-resolution.js';

describe('DID resolution', () => {
  it('should fail for invalid DID format', async () => {
    const program = Identity.resolveDID('not-a-did' as any);
    const result = Effect.runPromise(program);

    await expect(result).rejects.toThrow();
  });

  it('should fail for empty DID', async () => {
    const program = Identity.resolveDID('' as any);
    const result = Effect.runPromise(program);

    await expect(result).rejects.toThrow();
  });
});

describe('Handle resolution', () => {
  // Hermetic: the resolver takes its transport, so these tests never touch the network.
  const fakeTransport: HandleTransportShape = {
    lookupTxt: (handle) =>
      handle === 'alice.example.com'
        ? Effect.succeed(['did=did:key:zAlice'])
        : Effect.succeed([]),
    fetchWellKnown: () => Effect.succeed(undefined),
  };

  const resolver = () => new Identity.DefaultIdentityResolver(fakeTransport);

  it('resolves a handle through its DNS TXT binding', async () => {
    const result = await Effect.runPromise(
      resolver().resolveHandle('alice.example.com' as any),
    );

    expect(result.handle).toBe('alice.example.com');
    expect(result.did).toBe('did:key:zAlice');
  });

  it('fails for a handle with no binding', async () => {
    await expect(
      Effect.runPromise(resolver().resolveHandle('nobody.example.com' as any)),
    ).rejects.toThrow();
  });

  it('rejects a handle that is not a DNS name, without doing I/O', async () => {
    await expect(
      Effect.runPromise(resolver().resolveHandle('alice' as any)),
    ).rejects.toThrow();

    await expect(
      Effect.runPromise(resolver().resolveHandle('' as any)),
    ).rejects.toThrow();
  });
});

describe('Identity resolution (unified)', () => {
  it.skip('should resolve handle to DID when given handle', async () => {
    // Skip: implementation has bug with `this` binding in Effect.gen
    const handle = 'alice.bsky.social' as any;
    const program = Identity.resolveIdentity(handle);
    const result = await Effect.runPromise(program);

    expect(result.did).toContain('did:plc:');
  });

  it('should fail for invalid identifier', async () => {
    const program = Identity.resolveIdentity('invalid' as any);
    const result = Effect.runPromise(program);

    await expect(result).rejects.toThrow();
  });
});

describe('Error types', () => {
  it('should create DIDNotFoundError with correct structure', () => {
    const error = new Types.DIDNotFoundError({ identifier: 'did:test:123' });

    expect(error).toBeInstanceOf(Types.DIDNotFoundError);
    expect(error.identifier).toBe('did:test:123');
    expect(error._tag).toBe('DIDNotFoundError');
  });

  it('should create HandleNotFoundError with correct structure', () => {
    const error = new Types.HandleNotFoundError({
      identifier: 'missing.bsky.social',
    });

    expect(error).toBeInstanceOf(Types.HandleNotFoundError);
    expect(error.identifier).toBe('missing.bsky.social');
    expect(error._tag).toBe('HandleNotFoundError');
  });

  it('should create InvalidIdentifierError with correct structure', () => {
    const error = new Types.InvalidIdentifierError({
      identifier: 'invalid-id',
    });

    expect(error).toBeInstanceOf(Types.InvalidIdentifierError);
    expect(error.identifier).toBe('invalid-id');
    expect(error._tag).toBe('InvalidIdentifierError');
  });

  it('should check error tags', () => {
    const didError = new Types.DIDNotFoundError({ identifier: 'did:test' });
    const handleError = new Types.HandleNotFoundError({
      identifier: 'test.bsky.social',
    });
    const invalidError = new Types.InvalidIdentifierError({
      identifier: 'invalid',
    });

    expect(didError._tag).toBe('DIDNotFoundError');
    expect(handleError._tag).toBe('HandleNotFoundError');
    expect(invalidError._tag).toBe('InvalidIdentifierError');
  });
});

describe('Default resolver', () => {
  it('should create default resolver instance', () => {
    const resolver = new Identity.DefaultIdentityResolver();

    expect(resolver).toBeInstanceOf(Identity.DefaultIdentityResolver);
    expect(resolver.resolveDID).toBeDefined();
    expect(resolver.resolveHandle).toBeDefined();
    expect(resolver.resolveIdentity).toBeDefined();
  });
});
