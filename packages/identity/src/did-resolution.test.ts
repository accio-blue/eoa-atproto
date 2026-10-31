import { type DID, type Handle } from '@eoa/core';
import {
  DidDocumentTransport,
  didMethod,
  didWebUrl,
  handleFromAlsoKnownAs,
  makeDidDocumentTransport,
  pdsEndpointOf,
  resolvePlcDocument,
  resolveWebDocument,
} from './did-resolution.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIDNotFoundError } from './types.js';
import { DefaultIdentityResolver } from './resolver.js';
import { Effect } from 'effect';
import { type HandleTransportShape } from './handle-resolution.js';

/**
 * A real document, captured from the live directory on 2026-09-26:
 *
 *   GET https://plc.directory/did:plc:z72i7hdynmk6r22z27h6tvur
 *
 * Inline rather than fetched, so these tests never touch the network - but it
 * is the bytes the directory actually serves, so a schema that drifts from
 * reality fails here.
 */
const BSKY_APP_DOCUMENT = `{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
    "https://w3id.org/security/suites/secp256k1-2019/v1"
  ],
  "id": "did:plc:z72i7hdynmk6r22z27h6tvur",
  "alsoKnownAs": ["at://bsky.app"],
  "verificationMethod": [
    {
      "id": "did:plc:z72i7hdynmk6r22z27h6tvur#atproto",
      "type": "Multikey",
      "controller": "did:plc:z72i7hdynmk6r22z27h6tvur",
      "publicKeyMultibase": "zQ3shQo6TF2moaqMTrUZEM1jeuYRQXeHEx4evX9751y2qPqRA"
    }
  ],
  "service": [
    {
      "id": "#atproto_pds",
      "type": "AtprotoPersonalDataServer",
      "serviceEndpoint": "https://puffball.us-east.host.bsky.network"
    }
  ]
}`;

const PDS_ENDPOINT = 'https://puffball.us-east.host.bsky.network';
const DID_PLC = 'did:plc:z72i7hdynmk6r22z27h6tvur' as DID;

const bodyFor = (bodies: { readonly [did: string]: string | undefined }) => ({
  fetchDocument: (did: string) => Effect.succeed(bodies[did]),
});

/** No handle resolves here; these tests are about documents. */
const noHandles: HandleTransportShape = {
  lookupTxt: () => Effect.succeed([]),
  fetchWellKnown: () => Effect.succeed(undefined),
};

const boundHandle = (did: DID) => ({
  lookupTxt: (_handle: string) => Effect.succeed([`did=${did}`]),
  fetchWellKnown: () => Effect.succeed(undefined),
});

describe('did:plc document resolution', () => {
  const transport = bodyFor({ [DID_PLC]: BSKY_APP_DOCUMENT });
  const resolver = new DefaultIdentityResolver(noHandles, transport);

  it('resolves the document, its handle claim and its aliases', async () => {
    const resolution = await Effect.runPromise(resolver.resolveDID(DID_PLC));

    expect(resolution.did).toBe(DID_PLC);
    expect(resolution.alsoKnownAs).toEqual(['at://bsky.app']);
    expect(resolution.handle).toBe('bsky.app');
    expect(resolution.didDocument.id).toBe(DID_PLC);
  });

  it('reads services from `service`, not from the verification methods', async () => {
    const resolution = await Effect.runPromise(resolver.resolveDID(DID_PLC));

    expect(resolution.services).toHaveLength(1);
    expect(resolution.services?.[0]?.id).toBe('#atproto_pds');
    expect(resolution.pds).toBe(PDS_ENDPOINT);

    // The bug this replaces: verification methods relabelled as services, so
    // the "service" was the signing key and there was no PDS to find.
    expect(resolution.services?.map((service) => service.id)).not.toContain(
      `${DID_PLC}#atproto`,
    );
  });

  it('carries the handle through a handle-first resolution', async () => {
    const resolution = await Effect.runPromise(
      new DefaultIdentityResolver(
        boundHandle(DID_PLC),
        transport,
      ).resolveIdentity('bsky.app' as Handle),
    );

    expect(resolution.handle).toBe('bsky.app');
    expect(resolution.pds).toBe(PDS_ENDPOINT);
  });

  it('fails when the directory does not know the DID', async () => {
    await expect(
      Effect.runPromise(
        new DefaultIdentityResolver(noHandles, bodyFor({})).resolveDID(DID_PLC),
      ),
    ).rejects.toThrow(DIDNotFoundError);
  });

  it('fails on a body that is not a PLC document', async () => {
    const bodies = [
      'not json at all',
      '{"id":"did:plc:z72i7hdynmk6r22z27h6tvur"}',
      '{"@context":[],"id":"did:plc:z72i7hdynmk6r22z27h6tvur","alsoKnownAs":[],"verificationMethod":[]}',
    ];

    for (const body of bodies) {
      await expect(
        Effect.runPromise(
          new DefaultIdentityResolver(
            noHandles,
            bodyFor({ [DID_PLC]: body }),
          ).resolveDID(DID_PLC),
        ),
      ).rejects.toThrow(DIDNotFoundError);
    }
  });

  it('resolves through the transport service as well as the shape', async () => {
    const document = await Effect.runPromise(
      resolvePlcDocument(DID_PLC).pipe(
        Effect.provideService(DidDocumentTransport, transport),
      ),
    );

    expect(document.id).toBe(DID_PLC);
    expect(document.service[0]?.serviceEndpoint).toBe(PDS_ENDPOINT);
  });
});

/**
 * A `did:web` app document: what a managing app publishes to say where it answers. No keys, because a
 * service resolution needs none — and that is the point, a did:web document may carry only services.
 */
const APP_DOCUMENT = `{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:appview.example",
  "alsoKnownAs": ["at://appview.example"],
  "service": [
    {
      "id": "#manage",
      "type": "AtprotoManagedSpace",
      "serviceEndpoint": "https://appview.example"
    }
  ]
}`;

const DID_WEB = 'did:web:appview.example' as DID;

describe('did:web document resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives the document URL from the identifier, per W3C did:web', () => {
    expect(didWebUrl('did:web:appview.example')).toBe(
      'https://appview.example/.well-known/did.json',
    );
    expect(didWebUrl('did:web:appview.example:pod:app')).toBe(
      'https://appview.example/pod/app/did.json',
    );
    // A port is percent-encoded in the identifier, so the host has to be decoded.
    expect(didWebUrl('did:web:localhost%3A8443')).toBe(
      'https://localhost:8443/.well-known/did.json',
    );
  });

  it('answers undefined for an identifier that cannot name an https URL', () => {
    for (const did of [
      'did:web:',
      'did:web:app view.example',
      'did:web:example.com:pod::app',
      'did:web:http%3A%2F%2Fexample.com',
      'did:plc:z72i7hdynmk6r22z27h6tvur',
    ]) {
      expect(didWebUrl(did)).toBeUndefined();
    }
  });

  it('fetches the derived URL, not a directory path', async () => {
    const asked: Array<string> = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(APP_DOCUMENT),
      });
    });

    // Pointed at a directory that does not exist: a did:web document must not go through it.
    const body = await Effect.runPromise(
      makeDidDocumentTransport('https://plc.invalid').fetchDocument(DID_WEB),
    );

    expect(asked).toEqual(['https://appview.example/.well-known/did.json']);
    expect(body).toBe(APP_DOCUMENT);
  });

  it('resolves the document, its handle claim and its services', async () => {
    const resolution = await Effect.runPromise(
      new DefaultIdentityResolver(
        noHandles,
        bodyFor({ [DID_WEB]: APP_DOCUMENT }),
      ).resolveDID(DID_WEB),
    );

    expect(resolution.did).toBe(DID_WEB);
    expect(resolution.handle).toBe('appview.example');
    expect(resolution.services?.map((service) => service.id)).toEqual([
      '#manage',
    ]);
    // No `#atproto_pds`, so no PDS - and that is not an error for an app document.
    expect(resolution.pds).toBeUndefined();
  });

  it('resolves through the transport service as well as the shape', async () => {
    const document = await Effect.runPromise(
      resolveWebDocument(DID_WEB).pipe(
        Effect.provideService(
          DidDocumentTransport,
          bodyFor({ [DID_WEB]: APP_DOCUMENT }),
        ),
      ),
    );

    expect(document.id).toBe(DID_WEB);
    // A document with no keys is still a document.
    expect(document.verificationMethod).toEqual([]);
  });

  it('resolves a document that names only itself, with no services', async () => {
    const resolution = await Effect.runPromise(
      new DefaultIdentityResolver(
        noHandles,
        bodyFor({ [DID_WEB]: '{"id":"did:web:appview.example"}' }),
      ).resolveDID(DID_WEB),
    );

    expect(resolution.services).toEqual([]);
    expect(resolution.pds).toBeUndefined();
  });

  it("fails when the document is missing, does not parse, or is somebody else's", async () => {
    for (const body of [
      undefined,
      'not json at all',
      '{"id":"did:plc:someone.else"}',
    ]) {
      await expect(
        Effect.runPromise(
          new DefaultIdentityResolver(
            noHandles,
            bodyFor({ [DID_WEB]: body }),
          ).resolveDID(DID_WEB),
        ),
      ).rejects.toThrow(DIDNotFoundError);
    }
  });
});

describe('document helpers', () => {
  it('reads the DID method', () => {
    expect(didMethod('did:plc:z72i7hdynmk6r22z27h6tvur')).toBe('plc');
    expect(didMethod('did:key:zAlice')).toBe('key');
  });

  it('accepts a fully qualified service id', () => {
    expect(
      pdsEndpointOf([
        {
          id: `${DID_PLC}#atproto_pds`,
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: PDS_ENDPOINT,
        },
      ]),
    ).toBe(PDS_ENDPOINT);
  });

  it('does not mistake a structured endpoint for a URL', () => {
    expect(
      pdsEndpointOf([
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: { url: PDS_ENDPOINT },
        },
      ]),
    ).toBeUndefined();
  });

  it('takes the first handle claim, and nothing when there is none', () => {
    expect(
      handleFromAlsoKnownAs(['https://example.com', 'at://alice.example.com']),
    ).toBe('alice.example.com');
    expect(handleFromAlsoKnownAs([])).toBeUndefined();
  });
});
