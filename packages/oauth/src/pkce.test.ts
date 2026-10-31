import { challengeFor, createVerifier, verifyChallenge } from './pkce.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

describe('PKCE S256', () => {
  it('reproduces the RFC 7636 Appendix B vector', async () => {
    // The RFC's own worked example: if this drifts, the challenge is not S256.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await Effect.runPromise(challengeFor(verifier));

    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('mints a verifier inside the RFC 7636 range', () => {
    const verifier = createVerifier();

    // 43-128 characters, and none outside the unreserved set
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  it('mints a different verifier every time', () => {
    const verifiers = new Set(
      Array.from({ length: 64 }, () => createVerifier()),
    );

    expect(verifiers.size).toBe(64);
  });

  it('accepts the verifier it committed to and rejects any other', async () => {
    const verifier = createVerifier();
    const challenge = await Effect.runPromise(challengeFor(verifier));

    await expect(
      Effect.runPromise(verifyChallenge({ verifier, challenge })),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(
        verifyChallenge({ verifier: createVerifier(), challenge }),
      ),
    ).resolves.toBe(false);
    await expect(
      Effect.runPromise(verifyChallenge({ verifier, challenge: 'not-it' })),
    ).resolves.toBe(false);
  });
});
