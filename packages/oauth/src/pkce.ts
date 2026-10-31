import { type CryptoError, base64urlEncode, sha256 } from '@eoa/crypto';
import { Effect } from 'effect';

/**
 * PKCE, S256 only.
 *
 * `plain` is not offered. The whole point of PKCE is that the value the client
 * commits to is not the value it later presents, so an interception between the
 * authorize request and the token exchange buys nothing; offering `plain` would
 * be offering the vulnerability back. A request that asks for it is refused where
 * the choice is read, not here.
 */

const TEXT_ENCODER = new TextEncoder();

/**
 * A fresh verifier: 32 random bytes, base64url — 43 characters, the bottom of
 * RFC 7636's 43-128 range and 256 bits of entropy.
 */
export const createVerifier = (): string =>
  base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

/** The challenge a verifier commits to: `base64url(SHA-256(ASCII(verifier)))`. */
export const challengeFor = (
  verifier: string,
): Effect.Effect<string, CryptoError> =>
  sha256(TEXT_ENCODER.encode(verifier)).pipe(Effect.map(base64urlEncode));

/** Whether a presented verifier matches the challenge the client committed to. */
export const verifyChallenge = (params: {
  readonly verifier: string;
  readonly challenge: string;
}): Effect.Effect<boolean, CryptoError> =>
  challengeFor(params.verifier).pipe(
    Effect.map((challenge) => challenge === params.challenge),
  );
