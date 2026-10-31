import { Effect, Layer } from 'effect';
import {
  HandleResolutionError,
  HandleTransport,
  type HandleTransportShape,
  HandleVerificationError,
  lookupTxtViaDoh,
  parseDidFromTxt,
  parseDidFromWellKnown,
  resolveHandleFromNetwork,
  resolveVerifiedHandle,
  verifyHandleBinding,
} from './handle-resolution.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DID } from '@eoa/core';
import { HandleNotFoundError } from './types.js';

const transportOf = (params: {
  readonly txt?: Record<string, readonly string[]>;
  readonly wellKnown?: Record<string, string>;
}) => ({
  lookupTxt: (handle: string) => Effect.succeed(params.txt?.[handle] ?? []),
  fetchWellKnown: (handle: string) =>
    Effect.succeed(params.wellKnown?.[handle]),
});

const withTransport = (transport: HandleTransportShape) =>
  Layer.succeed(HandleTransport, transport);

const resolve = (handle: string, transport: HandleTransportShape) =>
  Effect.runPromise(
    resolveHandleFromNetwork(handle).pipe(
      Effect.provide(withTransport(transport)),
    ),
  );

describe('handle resolution parsing', () => {
  it('finds did= in TXT records', () => {
    expect(parseDidFromTxt(['did=did:key:zAlice'])).toBe('did:key:zAlice');
    expect(parseDidFromTxt(['other=1', 'did=did:plc:abc'])).toBe('did:plc:abc');
    expect(
      parseDidFromTxt(['v=spf1 include:x', 'did=did:web:example.com']),
    ).toBe('did:web:example.com');
  });

  it('ignores TXT records without a did binding', () => {
    expect(parseDidFromTxt(['v=spf1 -all'])).toBeUndefined();
    expect(parseDidFromTxt([])).toBeUndefined();
  });

  it('parses a well-known body only when it is a DID', () => {
    expect(parseDidFromWellKnown('  did:key:zAlice\n')).toBe('did:key:zAlice');
    expect(parseDidFromWellKnown('not a did')).toBeUndefined();
    expect(parseDidFromWellKnown('')).toBeUndefined();
  });
});

describe('handle resolution order', () => {
  it('prefers the DNS TXT binding', async () => {
    const did = await resolve(
      'alice.example.com',
      transportOf({
        txt: { 'alice.example.com': ['did=did:key:zFromTxt'] },
        wellKnown: { 'alice.example.com': 'did:key:zFromHttp' },
      }),
    );

    expect(did).toBe('did:key:zFromTxt');
  });

  it('falls back to the well-known document', async () => {
    const did = await resolve(
      'alice.example.com',
      transportOf({ wellKnown: { 'alice.example.com': 'did:key:zFromHttp' } }),
    );

    expect(did).toBe('did:key:zFromHttp');
  });

  it('falls through to well-known when the TXT lookup fails', async () => {
    const failingTxt: HandleTransportShape = {
      lookupTxt: (handle) =>
        Effect.fail(
          new HandleResolutionError({
            handle,
            reason: 'dns',
            message: 'resolver unavailable',
          }),
        ),
      fetchWellKnown: () => Effect.succeed('did:key:zFromHttp'),
    };

    const did = await resolve('alice.example.com', failingTxt);
    expect(did).toBe('did:key:zFromHttp');
  });

  it('fails with HandleNotFoundError when neither source has a binding', async () => {
    await expect(
      resolve('nobody.example.com', transportOf({})),
    ).rejects.toBeInstanceOf(HandleNotFoundError);
  });
});

describe('handle binding verification', () => {
  it('accepts a document that claims the handle', async () => {
    await Effect.runPromise(
      verifyHandleBinding({
        handle: 'alice.example.com',
        did: 'did:key:zAlice' as DID,
        alsoKnownAs: ['at://alice.example.com'],
      }),
    );
  });

  it('rejects a document that does not claim the handle', async () => {
    await expect(
      Effect.runPromise(
        verifyHandleBinding({
          handle: 'alice.example.com',
          did: 'did:key:zAlice' as DID,
          alsoKnownAs: ['at://someone.else'],
        }),
      ),
    ).rejects.toBeInstanceOf(HandleVerificationError);
  });

  it('resolves and verifies in one step', async () => {
    const did = await Effect.runPromise(
      resolveVerifiedHandle({
        handle: 'alice.example.com',
        resolveDocument: () =>
          Effect.succeed({ alsoKnownAs: ['at://alice.example.com'] }),
      }).pipe(
        Effect.provide(
          withTransport(
            transportOf({
              txt: { 'alice.example.com': ['did=did:key:zAlice'] },
            }),
          ),
        ),
      ),
    );

    expect(did).toBe('did:key:zAlice');
  });

  it('rejects a verified resolution when the claim is missing', async () => {
    await expect(
      Effect.runPromise(
        resolveVerifiedHandle({
          handle: 'alice.example.com',
          resolveDocument: () => Effect.succeed({ alsoKnownAs: [] }),
        }).pipe(
          Effect.provide(
            withTransport(
              transportOf({
                txt: { 'alice.example.com': ['did=did:key:zAlice'] },
              }),
            ),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(HandleVerificationError);
  });
});

describe('DoH TXT fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the unquoted TXT value, which parses to its DID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ Answer: [{ data: '"did=did:plc:abc"' }] }),
            {
              status: 200,
            },
          ),
      ),
    );

    const records = await lookupTxtViaDoh('example.com');
    expect(records).toEqual(['did=did:plc:abc']);
    expect(parseDidFromTxt(records)).toBe('did:plc:abc');
  });

  it('rejoins a record split across chunks and asks for _atproto', async () => {
    let requested = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        requested = String(url);
        return new Response(
          JSON.stringify({ Answer: [{ data: '"did=did:plc:ab" "c"' }] }),
          {
            status: 200,
          },
        );
      }),
    );

    expect(await lookupTxtViaDoh('example.com')).toEqual(['did=did:plc:abc']);
    expect(requested).toContain('_atproto.example.com');
  });

  it('is empty when the resolver does not answer ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    expect(await lookupTxtViaDoh('example.com')).toEqual([]);
  });
});
