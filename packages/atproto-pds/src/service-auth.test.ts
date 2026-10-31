import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { serviceAuthToken, verifyServiceAuth } from './token.js';
import { generateES256KeyPair } from '@eoa/crypto';

// The token that proves an account's DID to another service — the source half of a move. What it
// has to be is narrow: one audience, one method, minutes long. And it has to be checkable by
// somebody who has nothing but the issuer's DID document, which is why the key is the verifier's
// input and never a claim inside the token.

const NOW = 1_770_000_000_000;

const failed = (effect: Effect.Effect<unknown, unknown, never>) =>
  Effect.runPromiseExit(effect).then(Exit.isFailure);

describe('atproto-pds: the service-auth token', () => {
  it('verifies with the key the issuer document names, and carries the claims it should', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const token = await Effect.runPromise(
      serviceAuthToken({
        key: keys.privateKey,
        iss: 'did:web:pds.lexicon.ing:abc123',
        aud: 'did:web:pds.cssints.dev',
        lxm: 'com.atproto.repo.putRecord',
        now: NOW,
      }),
    );

    const claims = await Effect.runPromise(
      verifyServiceAuth({
        key: { curve: 'p256', key: keys.publicKey },
        token,
        audience: 'did:web:pds.cssints.dev',
        now: NOW,
      }),
    );
    expect(claims).toEqual({
      iss: 'did:web:pds.lexicon.ing:abc123',
      aud: 'did:web:pds.cssints.dev',
      iat: 1_770_000_000,
      exp: 1_770_000_000 + 60,
      lxm: 'com.atproto.repo.putRecord',
    });
  });

  it('is not a session token: no scope, no session, and no method when none was asked for', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const token = await Effect.runPromise(
      serviceAuthToken({
        key: keys.privateKey,
        iss: 'did:web:a',
        aud: 'did:web:b',
        now: NOW,
      }),
    );
    const claims = await Effect.runPromise(
      verifyServiceAuth({
        key: { curve: 'p256', key: keys.publicKey },
        token,
        audience: 'did:web:b',
        now: NOW,
      }),
    );

    expect(claims.lxm).toBeUndefined();
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss']);
  });

  it('is refused for another audience, for a stranger key, and once its lifetime is spent', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const stranger = await Effect.runPromise(generateES256KeyPair());
    const token = await Effect.runPromise(
      serviceAuthToken({
        key: keys.privateKey,
        iss: 'did:web:a',
        aud: 'did:web:b',
        now: NOW,
        lifetimeSeconds: 30,
      }),
    );

    // Addressed to somebody else is not addressed to us.
    expect(
      await failed(
        verifyServiceAuth({
          key: { curve: 'p256', key: keys.publicKey },
          token,
          audience: 'did:web:c',
          now: NOW,
        }),
      ),
    ).toBe(true);
    // A key that is not the issuer's does not verify: the signature is the whole claim.
    expect(
      await failed(
        verifyServiceAuth({
          key: { curve: 'p256', key: stranger.publicKey },
          token,
          audience: 'did:web:b',
          now: NOW,
        }),
      ),
    ).toBe(true);
    // And it does not outlive the lifetime it was minted with.
    expect(
      await failed(
        verifyServiceAuth({
          key: { curve: 'p256', key: keys.publicKey },
          token,
          audience: 'did:web:b',
          now: NOW + 31_000,
        }),
      ),
    ).toBe(true);
    // While the same token, in the window it was minted for, is fine.
    expect(
      Exit.isSuccess(
        await Effect.runPromiseExit(
          verifyServiceAuth({
            key: { curve: 'p256', key: keys.publicKey },
            token,
            audience: 'did:web:b',
            now: NOW + 29_000,
          }),
        ),
      ),
    ).toBe(true);
  });
});
