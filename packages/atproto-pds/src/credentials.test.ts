import {
  ACCESS_SCOPE,
  REFRESH_SCOPE,
  type VerifyRequest,
  accessToken,
  refreshToken,
  verifyToken,
} from './token.js';
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  digestSecret,
  hashPassword,
  newAppPassword,
  newInviteCode,
  randomId,
  sameSecret,
  verifyPassword,
} from './password.js';
import { generateES256KeyPair } from '@eoa/crypto';

/** Did it refuse? The shape of the refusal is the other test's business. */
const refused = async <A, E>(effect: Effect.Effect<A, E>) =>
  Result.isFailure(await Effect.runPromise(Effect.result(effect)));

describe('secrets', () => {
  it('stores a human password as a salted hash, and checks it', async () => {
    const hash = await Effect.runPromise(hashPassword('correct horse'));
    expect(hash.startsWith('pbkdf2c$600000$')).toBe(true);
    expect(await Effect.runPromise(verifyPassword('correct horse', hash))).toBe(
      true,
    );
    expect(await Effect.runPromise(verifyPassword('correct hors', hash))).toBe(
      false,
    );
    // A salt of its own, so the same password is a different row every time.
    const again = await Effect.runPromise(hashPassword('correct horse'));
    expect(again).not.toBe(hash);
    expect(
      await Effect.runPromise(verifyPassword('correct horse', again)),
    ).toBe(true);
    // A hash we cannot parse is a mismatch, not a crash.
    expect(
      await Effect.runPromise(verifyPassword('correct horse', 'junk')),
    ).toBe(false);
  });

  it('mints app passwords, invite codes and ids in the shapes atproto uses', () => {
    expect(newAppPassword()).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/u);
    expect(newInviteCode()).toMatch(/^[a-z2-7]{5}(-[a-z2-7]{5}){4}$/u);
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(newAppPassword()).not.toBe(newAppPassword());
    expect(randomId()).not.toBe(randomId());
  });

  it('digests a random secret, and compares two without leaking where', async () => {
    const digest = await Effect.runPromise(digestSecret('abcd-efgh-ijkl-mnop'));
    expect(
      await Effect.runPromise(sameSecret('abcd-efgh-ijkl-mnop', digest)),
    ).toBe(true);
    expect(
      await Effect.runPromise(sameSecret('abcd-efgh-ijkl-mnop', 'x')),
    ).toBe(false);
  });
});

describe('session tokens', () => {
  it('signs a token that verifies, and refuses anything else', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const now = 1_700_000_000_000;
    const request = {
      key: keys.privateKey,
      did: 'did:web:pds.example:alice',
      audience: 'did:web:pds.example',
      sessionId: 'session-1',
      now,
    };
    const token = await Effect.runPromise(accessToken(request));
    const verify: VerifyRequest = {
      key: keys.publicKey,
      token,
      audience: 'did:web:pds.example',
      scope: ACCESS_SCOPE,
      now,
    };

    const payload = await Effect.runPromise(verifyToken(verify));
    expect(payload).toMatchObject({
      scope: ACCESS_SCOPE,
      sub: 'did:web:pds.example:alice',
      aud: 'did:web:pds.example',
      jti: 'session-1',
    });
    expect(payload.exp).toBeGreaterThan(payload.iat);

    // Another server's audience, the wrong scope, a moment too late.
    expect(
      await refused(
        verifyToken({ ...verify, audience: 'did:web:elsewhere.example' }),
      ),
    ).toBe(true);
    expect(
      await refused(verifyToken({ ...verify, scope: REFRESH_SCOPE })),
    ).toBe(true);
    expect(
      await refused(verifyToken({ ...verify, now: now + 3 * 60 * 60 * 1000 })),
    ).toBe(true);
    // A refresh token is not an access token.
    const refresh = await Effect.runPromise(refreshToken(request));
    expect(await refused(verifyToken({ ...verify, token: refresh }))).toBe(
      true,
    );
    expect(
      await Effect.runPromise(
        verifyToken({ ...verify, token: refresh, scope: REFRESH_SCOPE }),
      ),
    ).toMatchObject({ scope: REFRESH_SCOPE });

    // A payload rewritten by hand does not verify; nor does rubbish.
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -4)}AAAA`;
    expect(await refused(verifyToken({ ...verify, token: forged }))).toBe(true);
    expect(
      await refused(verifyToken({ ...verify, token: 'not-a-token' })),
    ).toBe(true);
    // And a token signed by someone else is not ours.
    const other = await Effect.runPromise(generateES256KeyPair());
    const theirs = await Effect.runPromise(
      accessToken({ ...request, key: other.privateKey }),
    );
    expect(await refused(verifyToken({ ...verify, token: theirs }))).toBe(true);
  });
});
