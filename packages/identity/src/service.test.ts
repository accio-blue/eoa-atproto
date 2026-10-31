import { describe, expect, it } from 'vitest';
import { resolveServiceEndpoint, serviceEndpointOf } from './service.js';
import { Effect } from 'effect';
import { type IdentityResolver } from './types.js';

/**
 * `managingApp` is a DID **and a fragment**, and the fragment is only meaningful
 * against the document the DID resolves to. These are the three ways that can
 * go wrong before any request is made, each one a denial the PDS reports.
 */

const resolverWith = (endpoint: string | undefined) =>
  ({
    resolveDID: (did) =>
      Effect.succeed({
        did,
        didDocument: {
          id: did,
          verificationMethod: [],
          ...(endpoint === undefined
            ? {}
            : {
                service: [
                  {
                    id: '#forum',
                    type: 'AtprotoManagingApp',
                    serviceEndpoint: endpoint,
                  },
                ],
              }),
        },
        services:
          endpoint === undefined
            ? []
            : [
                {
                  id: '#forum',
                  type: 'AtprotoManagingApp',
                  serviceEndpoint: endpoint,
                },
              ],
      }),
    resolveHandle: () => Effect.die('unused'),
    resolveIdentity: () => Effect.die('unused'),
  }) satisfies IdentityResolver;

describe('resolving a service identifier', () => {
  it('finds the endpoint the document advertises for the fragment', async () => {
    const resolved = await Effect.runPromise(
      resolveServiceEndpoint({
        identifier: 'did:web:forum.example#forum',
        resolver: resolverWith('https://forum.example/xrpc'),
      }),
    );
    expect(resolved.endpoint).toBe('https://forum.example/xrpc');
    expect(resolved.fragment).toBe('forum');
  });

  it('accepts the fragment alone and the full id', () => {
    const services = [
      {
        id: '#forum',
        type: 'AtprotoManagingApp',
        serviceEndpoint: 'https://a',
      },
    ];
    expect(
      serviceEndpointOf({ did: 'did:web:x', fragment: 'forum', services }),
    ).toBe('https://a');
    expect(
      serviceEndpointOf({
        did: 'did:web:x',
        fragment: 'forum',
        services: [
          {
            id: 'did:web:x#forum',
            type: 'AtprotoManagingApp',
            serviceEndpoint: 'https://b',
          },
        ],
      }),
    ).toBe('https://b');
  });

  it('refuses an identifier with no fragment', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        resolveServiceEndpoint({
          identifier: 'did:web:forum.example',
          resolver: resolverWith('https://forum.example'),
        }),
      ),
    );
    expect(failure.reason).toContain('DID and a #fragment');
  });

  it('refuses a document that advertises no such service', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        resolveServiceEndpoint({
          identifier: 'did:web:forum.example#forum',
          resolver: resolverWith(undefined),
        }),
      ),
    );
    expect(failure.reason).toContain('advertises no #forum service');
  });
});
