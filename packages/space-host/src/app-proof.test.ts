import {
  APP_PROOF_TTL_SECONDS,
  didWebUrlOf,
  resolveDidWebKey,
  signAppProof,
  verifyAppProof,
} from './app-proof.js';
import {
  createDIDKey,
  exportPublicKey,
  generateES256KeyPair,
} from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

const APP = 'did:web:appview.example:identity';
const HOST = 'did:web:pds.example';
const NOW = 1_760_000_000_000;

const world = async () => {
  const keys = await Effect.runPromise(generateES256KeyPair());
  const keyDid = await Effect.runPromise(createDIDKey(keys.publicKey));
  const publicJwk = await Effect.runPromise(exportPublicKey(keys.publicKey));
  const jkt = `${publicJwk.x}.${publicJwk.y}`;
  const document = JSON.stringify({
    id: APP,
    verificationMethod: [
      {
        id: `${APP}#atproto`,
        type: 'Multikey',
        controller: APP,
        publicKeyMultibase: keyDid.slice('did:key:'.length),
      },
    ],
  });
  const proof = await Effect.runPromise(
    signAppProof({
      app: APP,
      audience: HOST,
      jkt,
      now: NOW,
      key: keys.privateKey,
    }),
  );
  return { keys, document, jkt, proof };
};

const resolveWith = (document: string | undefined) =>
  resolveDidWebKey({
    did: APP,
    fetchText: () => Effect.succeed(document ?? ''),
  });

describe('the app proof', () => {
  it('resolves a did:web path document and its key', async () => {
    const { document } = await world();
    expect(didWebUrlOf(APP)).toEqual({
      url: 'https://appview.example/identity/did.json',
    });
    const resolved = await Effect.runPromise(resolveWith(document));
    expect(resolved.ok).toBe(true);
  });

  it('verifies a proof the key signed, for this host, while it lasts', async () => {
    const { document, jkt, proof } = await world();
    const resolved = await Effect.runPromise(resolveWith(document));
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    const verdict = await Effect.runPromise(
      verifyAppProof({
        proof,
        key: resolved.key,
        audience: HOST,
        now: NOW + 1000,
      }),
    );
    expect(verdict).toMatchObject({ ok: true, jkt });
  });

  it('refuses another host, an expired proof, and a document that is not the app', async () => {
    const { document, proof } = await world();
    const resolved = await Effect.runPromise(resolveWith(document));
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    expect(
      await Effect.runPromise(
        verifyAppProof({
          proof,
          key: resolved.key,
          audience: 'did:web:other',
          now: NOW,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'not for this host' });
    expect(
      await Effect.runPromise(
        verifyAppProof({
          proof,
          key: resolved.key,
          audience: HOST,
          now: NOW + (APP_PROOF_TTL_SECONDS + 10) * 1000,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'expired' });

    const impostor = document.replace(APP, 'did:web:stranger.example');
    expect(await Effect.runPromise(resolveWith(impostor))).toMatchObject({
      ok: false,
    });
  });

  it('does not accept a proof signed by another key', async () => {
    const { document, proof, jkt } = await world();
    const resolved = await Effect.runPromise(resolveWith(document));
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    const impostor = await Effect.runPromise(generateES256KeyPair());
    const forged = await Effect.runPromise(
      signAppProof({
        app: APP,
        audience: HOST,
        jkt,
        now: NOW,
        key: impostor.privateKey,
      }),
    );
    expect(
      await Effect.runPromise(
        verifyAppProof({
          proof: forged,
          key: resolved.key,
          audience: HOST,
          now: NOW,
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'the signature does not verify' });
    // and the genuine one still verifies: the refusal was the key, not the shape
    expect(
      await Effect.runPromise(
        verifyAppProof({ proof, key: resolved.key, audience: HOST, now: NOW }),
      ),
    ).toMatchObject({ ok: true });
  });
});
