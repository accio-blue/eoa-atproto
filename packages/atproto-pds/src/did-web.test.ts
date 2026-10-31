import { Effect, Option } from 'effect';
import { createDIDKey, generateES256KeyPair } from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { didWebDocumentOf, didWebPathOf, documentHostOf } from './did-web.js';

// The document a `did:web` identity resolves to: the host saying who it is. It is the whole
// registry for the method, so what it must say is exactly this much and no less.

describe('atproto-pds: the did:web document', () => {
  it('says who the host is, what it signs with, and where its PDS is', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const expected = await Effect.runPromise(createDIDKey(keys.publicKey));
    const document = await Effect.runPromise(
      didWebDocumentOf({
        did: 'did:web:pds.lexicon.ing',
        endpoint: 'https://pds.lexicon.ing',
        signingKey: keys.privateKey,
      }),
    );

    expect(document.id).toBe('did:web:pds.lexicon.ing');
    expect(document.service).toEqual([
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.lexicon.ing',
      },
    ]);
    // The key a resolver verifies repos with is the key the PDS signs them with — the `did:key`s
    // own encoding, because that is the form atproto writes and reads.
    expect(document.verificationMethod[0]?.publicKeyMultibase).toBe(
      expected.replace(/^did:key:/, ''),
    );
    expect(document.verificationMethod[0]?.controller).toBe(document.id);
    expect(document.verificationMethod[0]?.id).toBe(
      'did:web:pds.lexicon.ing#atproto',
    );
  });

  it('carries the account KEM key, because nothing else can publish it', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const kem = await Effect.runPromise(
      createDIDKey((await Effect.runPromise(generateES256KeyPair())).publicKey),
    );
    const document = await Effect.runPromise(
      didWebDocumentOf({
        did: 'did:web:pds.lexicon.ing:acc',
        endpoint: 'https://pds.lexicon.ing',
        signingKey: keys.privateKey,
        kemKey: kem,
      }),
    );

    // `#atproto` still signs; `#atproto_kem` only decapsulates, and a syncer looks it up by id.
    expect(document.verificationMethod.map((one) => one.id)).toEqual([
      'did:web:pds.lexicon.ing:acc#atproto',
      'did:web:pds.lexicon.ing:acc#atproto_kem',
    ]);
    expect(document.verificationMethod[1]?.publicKeyMultibase).toBe(
      kem.replace(/^did:key:/, ''),
    );
  });
});

// An account's identity is a `did:web` with a path, and these are the two decisions that make one
// resolve: the host it is minted under, and the path a resolver asks at.

describe('atproto-pds: the host a document is minted under', () => {
  it('is the host that serves it, not the handle domain', () => {
    expect(
      documentHostOf({
        publicUrl: 'https://pds.lexicon.ing',
        domain: 'lexicon.ing',
      }),
    ).toBe('pds.lexicon.ing');
    // A trailing slash is not a different host.
    expect(
      documentHostOf({
        publicUrl: 'https://pds.lexicon.ing/',
        domain: 'lexicon.ing',
      }),
    ).toBe('pds.lexicon.ing');
  });

  it('is the handle domain when the deployment has said nothing about where documents live', () => {
    expect(documentHostOf({ domain: 'lexicon.ing' })).toBe('lexicon.ing');
    expect(documentHostOf({ publicUrl: '', domain: 'lexicon.ing' })).toBe(
      'lexicon.ing',
    );
    expect(
      documentHostOf({ publicUrl: 'not a url', domain: 'lexicon.ing' }),
    ).toBe('lexicon.ing');
  });
});

describe('atproto-pds: the path a did:web resolves at', () => {
  const host = 'pds.lexicon.ing';

  it('reads the one segment a path did:web carries', () => {
    expect(
      Option.getOrNull(didWebPathOf({ path: '/nlf1JsCs6Oh/did.json', host })),
    ).toBe('did:web:pds.lexicon.ing:nlf1JsCs6Oh');
    // Encoded on the way in, decoded on the way out: the segment is an id, not a URL.
    expect(
      Option.getOrNull(didWebPathOf({ path: '/nlf%2B1/did.json', host })),
    ).toBe('did:web:pds.lexicon.ing:nlf+1');
  });

  it("is not the host's own document, and not anything else", () => {
    for (const path of [
      '/.well-known/did.json',
      '/did.json',
      '/a/b/did.json',
      '/nlf1JsCs6Oh/did.json/',
      '/nlf1JsCs6Oh',
      '/xrpc/com.atproto.repo.getRecord',
      '/%ZZ/did.json',
    ]) {
      expect(Option.isNone(didWebPathOf({ path, host }))).toBe(true);
    }
  });
});
