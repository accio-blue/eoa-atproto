import { Effect, Schema } from 'effect';
import {
  SPACE_CREDENTIAL_TTL_SECONDS,
  credentialFor,
  jktOf,
  mintSpaceCredential,
  verifySpaceCredential,
} from './credential.js';
import { describe, expect, it } from 'vitest';
import { generateES256KeyPair, sign } from '@eoa/crypto';
import { DID } from '@eoa/core';

const SPACE = 'atproto:did:plc:authority:com.atproto.memberspace:studio';
const AUTHORITY = 'did:plc:authority';
const APP = 'did:web:appview.example';
const MEMBER = 'did:plc:reader';
const reader = Schema.decodeUnknownSync(DID)('did:plc:reader');
const authorityDid = Schema.decodeUnknownSync(DID)(AUTHORITY);
const NOW = 1_760_000_000_000;

const world = async () => {
  const authority = await Effect.runPromise(generateES256KeyPair());
  const app = await Effect.runPromise(generateES256KeyPair());
  const jkt = await Effect.runPromise(
    jktOf({
      crv: 'P-256',
      kty: 'EC',
      x: 'x-coordinate',
      y: 'y-coordinate',
    }),
  );
  const token = await Effect.runPromise(
    mintSpaceCredential({
      issuer: AUTHORITY,
      audience: AUTHORITY,
      key: authority.privateKey,
      space: SPACE,
      app: APP,
      member: MEMBER,
      jkt,
      now: NOW,
    }),
  );
  return { authority, app, jkt, token };
};

const check = (params: {
  readonly token: string;
  readonly authority: Awaited<ReturnType<typeof world>>['authority'];
  readonly jkt: string;
  readonly now?: number;
  readonly space?: string;
  readonly app?: string;
}) =>
  Effect.runPromise(
    verifySpaceCredential({
      token: params.token,
      key: params.authority.publicKey,
      audience: AUTHORITY,
      space: params.space ?? SPACE,
      now: params.now ?? NOW + 1000,
      jkt: params.jkt,
      ...(params.app === undefined ? {} : { app: params.app }),
    }),
  );

describe('the space credential', () => {
  it('opens the space it names, for the app it names, while it lasts', async () => {
    const { authority, jkt, token } = await world();
    const verdict = await check({ token, authority, jkt, app: APP });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.credential.sub).toBe(APP);
      expect(verdict.credential.member).toBe(MEMBER);
      expect(verdict.credential.exp - verdict.credential.iat).toBe(
        SPACE_CREDENTIAL_TTL_SECONDS,
      );
    }
  });

  it('refuses a token minted before the member claim existed', async () => {
    const { authority, jkt, token } = await world();
    const [header, body] = token.split('.');
    const claims = JSON.parse(
      Buffer.from(body ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    delete claims['member'];
    const stripped = Buffer.from(JSON.stringify(claims)).toString('base64url');
    // Re-signed by the authority, so the refusal is the missing claim and not the signature.
    const signature = await Effect.runPromise(
      sign(
        authority.privateKey,
        new TextEncoder().encode(`${header}.${stripped}`),
      ),
    );
    const legacy = `${header}.${stripped}.${Buffer.from(signature).toString('base64url')}`;
    expect(await check({ token: legacy, authority, jkt })).toEqual({
      ok: false,
      reason: 'bad-payload',
    });
  });

  it('is useless without the key it is bound to', async () => {
    const { authority, token } = await world();
    const other = await Effect.runPromise(
      jktOf({ crv: 'P-256', kty: 'EC', x: 'other', y: 'other' }),
    );
    const verdict = await check({ token, authority, jkt: other });
    expect(verdict).toEqual({ ok: false, reason: 'not-bound' });
  });

  it('stops opening its space when it expires', async () => {
    const { authority, jkt, token } = await world();
    const verdict = await check({
      token,
      authority,
      jkt,
      now: NOW + SPACE_CREDENTIAL_TTL_SECONDS * 1000 + 1000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  it('opens nothing else: another space, another audience, another app', async () => {
    const { authority, jkt, token } = await world();
    expect(
      await check({ token, authority, jkt, space: 'atproto:x:y:z' }),
    ).toEqual({
      ok: false,
      reason: 'wrong-space',
    });
    expect(
      await check({ token, authority, jkt, app: 'did:web:other' }),
    ).toEqual({
      ok: false,
      reason: 'wrong-app',
    });
  });

  it('does not survive a rewritten claim', async () => {
    const { authority, jkt, token } = await world();
    const [header, body, signature] = token.split('.');
    const claims = JSON.parse(
      Buffer.from(body ?? '', 'base64url').toString('utf8'),
    ) as { space: string };
    claims.space = 'atproto:did:plc:authority:com.atproto.memberspace:other';
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    expect(await check({ token: forged, authority, jkt })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('is checked against the authority it names, not any key', async () => {
    const { token } = await world();
    const impostor = await Effect.runPromise(generateES256KeyPair());
    const verdict = await Effect.runPromise(
      verifySpaceCredential({
        token,
        key: impostor.publicKey,
        audience: AUTHORITY,
        space: SPACE,
        now: NOW + 1000,
        jkt: 'anything',
      }),
    );
    expect(verdict).toEqual({ ok: false, reason: 'bad-signature' });
  });
});

describe('the authority deciding, not just verifying', () => {
  const memberPolicy = (allowedApps?: ReadonlyArray<string>) => ({
    $type: 'com.atproto.memberspace.policy' as const,
    publicRead: true,
    ...(allowedApps === undefined ? {} : { allowedApps: [...allowedApps] }),
  });

  const issue = async (params: {
    readonly allowed?: ReadonlyArray<string>;
    readonly app?: string | undefined;
  }) => {
    const authority = await Effect.runPromise(generateES256KeyPair());
    const jkt = await Effect.runPromise(
      jktOf({ crv: 'P-256', kty: 'EC', x: 'x', y: 'y' }),
    );
    return {
      authority,
      verdict: await Effect.runPromise(
        credentialFor({
          policy: memberPolicy(params.allowed),
          did: reader,
          authority: authorityDid,
          audience: AUTHORITY,
          member: { read: true, write: false },
          app: params.app,
          space: SPACE,
          jkt,
          key: authority.privateKey,
          now: NOW,
        }),
      ),
    };
  };

  it('mints for an app the policy names', async () => {
    const { authority, verdict } = await issue({ allowed: [APP], app: APP });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      const checked = await Effect.runPromise(
        verifySpaceCredential({
          token: verdict.token,
          key: authority.publicKey,
          audience: AUTHORITY,
          space: SPACE,
          now: NOW + 1000,
          jkt: await Effect.runPromise(
            jktOf({ crv: 'P-256', kty: 'EC', x: 'x', y: 'y' }),
          ),
        }),
      );
      expect(checked.ok).toBe(true);
    }
  });

  it('mints nothing for an app the policy does not name', async () => {
    expect(await issue({ allowed: [APP], app: 'did:web:other' })).toMatchObject(
      {
        verdict: { ok: false, reason: 'app-not-allowed' },
      },
    );
  });

  it('mints nothing without an attested app', async () => {
    expect(await issue({ app: undefined })).toMatchObject({
      verdict: { ok: false, reason: 'no-app' },
    });
  });

  it('asks the managing app instead of minting on a managed space', async () => {
    const authority = await Effect.runPromise(generateES256KeyPair());
    const verdict = await Effect.runPromise(
      credentialFor({
        policy: {
          $type: 'com.atproto.managedspace.policy',
          managingApp: 'did:web:forum.example',
        },
        did: reader,
        authority: authorityDid,
        audience: AUTHORITY,
        member: undefined,
        app: APP,
        space: SPACE,
        jkt: 'jkt',
        key: authority.privateKey,
        now: NOW,
      }),
    );
    expect(verdict).toEqual({ ok: false, reason: 'the-managing-app-decides' });
  });
});
