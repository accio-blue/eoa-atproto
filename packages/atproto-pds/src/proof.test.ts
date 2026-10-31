import { Effect, Exit, Option } from 'effect';
import { accessToken, serviceAuthToken, verifyServiceAuth } from './token.js';
import { atprotoKeyOf, didDocumentUrlOf, proofOfControl } from './proof.js';
import {
  base64urlEncode,
  generateES256KeyPair,
  secp256k1KeyFromScalar,
  signSecp256k1,
} from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { didWebDocumentOf } from './did-web.js';

// Proof of control: the gate that decides whether a caller may claim a DID this PDS does not host.
// Every check here is load-bearing, so every one of them gets a refusal rather than a smaller claim:
// the document, the key inside it, the audience, the issuer, the clock.

const NOW = 1_770_000_000_000;
const AUDIENCE = 'did:web:pds.cssints.dev';
const DID = 'did:web:pds.lexicon.ing:abc123';
/** The method a token has to be good for when it names one: the call that needs the proof. */
const METHOD = 'com.atproto.server.createAccount';

const failed = (effect: Effect.Effect<unknown, unknown, never>) =>
  Effect.runPromiseExit(effect).then(Exit.isFailure);

const keysOf = () => Effect.runPromise(generateES256KeyPair());

type SigningKey = Parameters<typeof didWebDocumentOf>[0]['signingKey'];

/** The document a source PDS would serve: built by the very code that builds ours. */
const documentFor = (params: {
  readonly signingKey: SigningKey;
  readonly did?: string;
}) =>
  Effect.runPromise(
    didWebDocumentOf({
      did: params.did ?? DID,
      endpoint: 'https://pds.lexicon.ing',
      signingKey: params.signingKey,
    }),
  );

const tokenFor = (params: {
  readonly key: SigningKey;
  readonly iss?: string;
  readonly aud?: string;
  readonly lxm?: string;
}) =>
  Effect.runPromise(
    serviceAuthToken({
      key: params.key,
      iss: params.iss ?? DID,
      aud: params.aud ?? AUDIENCE,
      ...(params.lxm === undefined ? {} : { lxm: params.lxm }),
      now: NOW,
    }),
  );

describe('atproto-pds: proof of control over a foreign DID', () => {
  it('resolves a document where the DID itself says it is', () => {
    const at = (params: Parameters<typeof didDocumentUrlOf>[0]) =>
      Option.getOrThrow(didDocumentUrlOf(params));

    expect(at({ did: 'did:web:pds.example' })).toBe(
      'https://pds.example/.well-known/did.json',
    );
    expect(at({ did: 'did:web:pds.example:a:b' })).toBe(
      'https://pds.example/a/b/did.json',
    );
    expect(at({ did: 'did:web:pds.example:%61' })).toBe(
      'https://pds.example/a/did.json',
    );
    // A `did:plc` names no document until a deployment says which directory serves it: there is no
    // default, because the public directory is a network this repo does not control -- and a closed
    // deployment reaching it is the one thing it exists not to do.
    expect(Option.isNone(didDocumentUrlOf({ did: 'did:plc:abc' }))).toBe(true);
    expect(
      at({ did: 'did:plc:abc', plcDirectoryUrl: 'https://plc.internal' }),
    ).toBe('https://plc.internal/did:plc:abc');
    // A method we cannot resolve, a host that is not there, and a segment that is not
    // percent-encoding: none of them name a document, so none of them may be trusted.
    expect(Option.isNone(didDocumentUrlOf({ did: 'did:key:z6Mk' }))).toBe(true);
    expect(Option.isNone(didDocumentUrlOf({ did: 'did:web:' }))).toBe(true);
    expect(Option.isNone(didDocumentUrlOf({ did: 'did:web:%zz' }))).toBe(true);
  });

  it('takes the key the document names, and only from the atproto method', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    const key = await Effect.runPromise(atprotoKeyOf({ did: DID, document }));

    // The extracted key is the document's own: it verifies what the document's key signs.
    const token = await tokenFor({ key: keys.privateKey });
    const claims = await Effect.runPromise(
      verifyServiceAuth({ key, token, audience: AUDIENCE, now: NOW }),
    );
    expect(claims.iss).toBe(DID);
  });

  it('reads a secp256k1 atproto key, which is what a did:plc minted elsewhere names', async () => {
    // Every account made on Bluesky or on Cirrus names a secp256k1 `#atproto` key, so a P-256-only
    // reader refused the documents a move arrives with — the failure this test exists for.
    const key = await Effect.runPromise(
      secp256k1KeyFromScalar(new Uint8Array(32).fill(7)),
    );
    const document = {
      verificationMethod: [
        {
          id: `${DID}#atproto`,
          publicKeyMultibase: key.didKey.slice('did:key:'.length),
        },
      ],
    };
    const read = await Effect.runPromise(atprotoKeyOf({ did: DID, document }));
    expect(read.curve).toBe('secp256k1');

    // A token such a source mints on that curve: the header says ES256K, the signature is raw r||s.
    // The field order is the one Cirrus actually sends, which is what the byte comparison used to
    // refuse while the claim inside it was perfectly good.
    const encoder = new TextEncoder();
    const header = base64urlEncode(
      encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256K' })),
    );
    const issued = Math.floor(NOW / 1000);
    const body = base64urlEncode(
      encoder.encode(
        JSON.stringify({
          iss: DID,
          aud: AUDIENCE,
          iat: issued,
          exp: issued + 60,
          lxm: METHOD,
        }),
      ),
    );
    const signature = await Effect.runPromise(
      signSecp256k1({ key, data: encoder.encode(`${header}.${body}`) }),
    );
    const token = `${header}.${body}.${base64urlEncode(signature)}`;

    const proven = await Effect.runPromise(
      proofOfControl({
        did: DID,
        token,
        audience: AUDIENCE,
        lxm: METHOD,
        now: NOW,
        fetchDocument: async () => document,
      }),
    );
    expect(proven).toBe(DID);

    // One flipped byte is a different claim, and a claim that does not verify is refused.
    const tampered = `${header}.${body}.${base64urlEncode(
      Uint8Array.from(signature, (byte, at) => (at === 0 ? byte ^ 1 : byte)),
    )}`;
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: tampered,
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => document,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a document that names no atproto key', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });

    expect(
      await failed(
        atprotoKeyOf({
          did: DID,
          document: { ...document, verificationMethod: [] },
        }),
      ),
    ).toBe(true);
    expect(
      await failed(
        atprotoKeyOf({
          did: DID,
          document: {
            verificationMethod: [{ id: '#other', publicKeyMultibase: 'zDna' }],
          },
        }),
      ),
    ).toBe(true);
    // A fetch that answers something that is not a document is refused too, and by the parse: the
    // rule below never sees it.
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: await tokenFor({ key: keys.privateKey }),
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => ({ verificationMethod: [] }),
        }),
      ),
    ).toBe(true);
  });

  it('proves control when the document names the key that minted the token', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    const proven = await Effect.runPromise(
      proofOfControl({
        did: DID,
        // Minted for this very method, which is what a source PDS mints when a move asks it to.
        token: await tokenFor({ key: keys.privateKey, lxm: METHOD }),
        audience: AUDIENCE,
        lxm: METHOD,
        now: NOW,
        fetchDocument: async () => document,
      }),
    );
    expect(proven).toBe(DID);
  });

  it('refuses a token addressed to somebody else', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: await tokenFor({
            key: keys.privateKey,
            aud: 'did:web:pds.elsewhere',
          }),
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => document,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a token signed by a key the document does not name', async () => {
    const keys = await keysOf();
    const someoneElse = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: await tokenFor({ key: someoneElse.privateKey }),
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => document,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a token that names a different identity', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: await tokenFor({
            key: keys.privateKey,
            iss: 'did:web:pds.lexicon.ing:elsewhere',
          }),
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => document,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a token that has expired', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: await tokenFor({ key: keys.privateKey }),
          audience: AUDIENCE,
          lxm: METHOD,
          // A token is minted to be presented at once; here it is presented ten minutes late.
          now: NOW + 10 * 60 * 1000,
          fetchDocument: async () => document,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a token minted for another method', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: await tokenFor({
            key: keys.privateKey,
            lxm: 'com.atproto.repo.putRecord',
          }),
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => document,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a session token: a proof is not a login', async () => {
    const keys = await keysOf();
    const document = await documentFor({ signingKey: keys.privateKey });
    // The same key, the same audience, the same shape of token — but a session token, which names
    // no issuer and is not addressed to a service at all.
    const session = await Effect.runPromise(
      accessToken({
        key: keys.privateKey,
        did: DID,
        audience: AUDIENCE,
        sessionId: 'a-session',
        now: NOW,
      }),
    );
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token: session,
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => document,
        }),
      ),
    ).toBe(true);
  });

  it('refuses when there is no document to check against', async () => {
    const keys = await keysOf();
    const token = await tokenFor({ key: keys.privateKey });
    expect(
      await failed(
        proofOfControl({
          did: 'did:key:z6Mk',
          token,
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => ({}),
        }),
      ),
    ).toBe(true);
    expect(
      await failed(
        proofOfControl({
          did: DID,
          token,
          audience: AUDIENCE,
          lxm: METHOD,
          now: NOW,
          fetchDocument: async () => {
            throw new Error('nothing is served there');
          },
        }),
      ),
    ).toBe(true);
  });
});
