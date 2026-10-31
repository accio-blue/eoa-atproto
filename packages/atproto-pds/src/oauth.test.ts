import { Effect, Result } from 'effect';
import {
  type PrivateKey,
  base64urlEncode,
  exportPublicKey,
  generateES256KeyPair,
  sha256,
  sign,
} from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { jwkThumbprint, verifyAccessToken, verifyProof } from './oauth.js';

/**
 * The resource server's half of OAuth, tested from the *other* side: this file
 * is the authorization server and the client, minting the tokens and the proofs
 * that the PDS then has to accept or refuse.
 *
 * The refusals are the point. A verifier that says yes is easy; the tests that
 * matter are the ones that say no for the right reason.
 */

const encoder = new TextEncoder();

const ISSUER = 'https://as.pds.example';

const AUDIENCE = 'did:web:pds.example';

const HTM = 'POST';

const HTU = `https://pds.example/xrpc/com.atproto.repo.createRecord`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Did it refuse? The reason is the other tests' business. */
const refused = async <A, E>(effect: Effect.Effect<A, E>) =>
  Result.isFailure(await Effect.runPromise(Effect.result(effect)));

/** The public half of a key, as a JWK — what a proof header and a config carry. */
const publicJwkOf = async (key: PrivateKey) => {
  const exported = await Effect.runPromise(exportPublicKey(key.publicKey));
  return {
    kty: 'EC',
    crv: 'P-256',
    x: String(exported.x),
    y: String(exported.y),
  };
};

/** The client: a DPoP proof for one request. */
const makeProof = async (params: {
  readonly key: PrivateKey;
  readonly htm: string;
  readonly htu: string;
  readonly accessToken: string;
  readonly jti?: string;
  readonly iat?: number;
  readonly alg?: string;
  readonly embedPrivateKey?: boolean;
}) => {
  const jwk = await publicJwkOf(params.key);
  const header = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        typ: 'dpop+jwt',
        alg: params.alg ?? 'ES256',
        jwk:
          params.embedPrivateKey === true
            ? { ...jwk, d: 'the-private-half' }
            : jwk,
      }),
    ),
  );
  const ath = base64urlEncode(
    await Effect.runPromise(sha256(encoder.encode(params.accessToken))),
  );
  const payload = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        jti: params.jti ?? 'proof-1',
        htm: params.htm.toUpperCase(),
        htu: params.htu,
        iat: params.iat ?? nowSeconds(),
        ath,
      }),
    ),
  );
  const signature = await Effect.runPromise(
    sign(params.key, encoder.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${base64urlEncode(signature)}`;
};

/** The authorization server: an access token bound to a key. */
const mintAccessToken = async (params: {
  readonly key: PrivateKey;
  readonly jkt: string;
  readonly sub: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly now?: number;
  readonly exp?: number;
  readonly scope?: string;
  readonly typ?: string;
  readonly alg?: string;
}) => {
  const now = params.now ?? nowSeconds();
  const header = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        typ: params.typ ?? 'at+jwt',
        alg: params.alg ?? 'ES256',
      }),
    ),
  );
  const payload = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        iss: params.iss ?? ISSUER,
        sub: params.sub,
        aud: params.aud ?? AUDIENCE,
        iat: now,
        exp: params.exp ?? now + 300,
        scope: params.scope ?? 'atproto',
        cnf: { jkt: params.jkt },
      }),
    ),
  );
  const signature = await Effect.runPromise(
    sign(params.key, encoder.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${base64urlEncode(signature)}`;
};

/** A client key, and the token that was issued to it. */
const setup = async () => {
  const issuer = await Effect.runPromise(generateES256KeyPair());
  const client = await Effect.runPromise(generateES256KeyPair());
  const jwk = await publicJwkOf(client.privateKey);
  const jkt = await Effect.runPromise(jwkThumbprint({ x: jwk.x, y: jwk.y }));
  const now = nowSeconds();
  const token = await mintAccessToken({
    key: issuer.privateKey,
    jkt,
    sub: 'did:web:pds.example:alice',
    now,
  });
  return { issuer, client, jwk, jkt, token, now };
};

describe('the RFC 7638 thumbprint', () => {
  it('is the canonical JSON, written out by hand', async () => {
    const client = await Effect.runPromise(generateES256KeyPair());
    const jwk = await publicJwkOf(client.privateKey);

    // The canonical form is *these* members in *this* order — lexicographic —
    // and writing it by hand here is what pins the order in the implementation.
    const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expected = base64urlEncode(
      await Effect.runPromise(sha256(encoder.encode(canonical))),
    );

    expect(await Effect.runPromise(jwkThumbprint({ x: jwk.x, y: jwk.y }))).toBe(
      expected,
    );
  });
});

describe('the access token', () => {
  it('verifies when it is from the issuer, for us, and bound to a key', async () => {
    const { issuer, jkt, token, now } = await setup();
    const claims = await Effect.runPromise(
      verifyAccessToken({
        token,
        issuer: ISSUER,
        audience: AUDIENCE,
        key: issuer.publicKey,
        now,
      }),
    );
    expect(claims).toMatchObject({
      did: 'did:web:pds.example:alice',
      jkt,
      scope: ['atproto'],
    });
  });

  it('refuses a token from anywhere else, for anyone else, or from another time', async () => {
    const { issuer, jkt, token, now } = await setup();
    const verify = (over: Partial<Parameters<typeof verifyAccessToken>[0]>) =>
      verifyAccessToken({
        token,
        issuer: ISSUER,
        audience: AUDIENCE,
        key: issuer.publicKey,
        now,
        ...over,
      });

    expect(await refused(verify({ issuer: 'https://elsewhere.example' }))).toBe(
      true,
    );
    expect(await refused(verify({ audience: 'did:web:other.example' }))).toBe(
      true,
    );
    expect(await refused(verify({ now: now + 3600 }))).toBe(true);
    // Signed by someone who is not the issuer.
    const other = await Effect.runPromise(generateES256KeyPair());
    expect(await refused(verify({ key: other.publicKey }))).toBe(true);

    // A session-style token is not an access token, and `alg: none` is not an
    // algorithm this build has ever verified.
    const wrongType = await mintAccessToken({
      key: issuer.privateKey,
      jkt,
      sub: 'did:web:pds.example:alice',
      typ: 'JWT',
      now,
    });
    expect(await refused(verify({ token: wrongType }))).toBe(true);
    const noAlg = await mintAccessToken({
      key: issuer.privateKey,
      jkt,
      sub: 'did:web:pds.example:alice',
      alg: 'none',
      now,
    });
    expect(await refused(verify({ token: noAlg }))).toBe(true);
    expect(await refused(verify({ token: 'not.a.token' }))).toBe(true);
  });
});

describe('the DPoP proof', () => {
  it('verifies for the request it was made for, and reports the key it is bound to', async () => {
    const { client, jkt, token, now } = await setup();
    const proof = await makeProof({
      key: client.privateKey,
      htm: HTM,
      htu: HTU,
      accessToken: token,
      iat: now,
    });
    const verified = await Effect.runPromise(
      verifyProof({ proof, htm: HTM, htu: HTU, accessToken: token, now }),
    );
    expect(verified).toMatchObject({ jkt, jti: 'proof-1' });
  });

  it('refuses a proof for another request, another moment, or another token', async () => {
    const { client, token, now } = await setup();
    const proofFor = (over: {
      readonly htm?: string;
      readonly htu?: string;
      readonly accessToken?: string;
      readonly iat?: number;
    }) =>
      makeProof({
        key: client.privateKey,
        htm: over.htm ?? HTM,
        htu: over.htu ?? HTU,
        accessToken: over.accessToken ?? token,
        iat: over.iat ?? now,
      });
    const verify = (over: {
      readonly proof: string;
      readonly htm?: string;
      readonly htu?: string;
      readonly accessToken?: string;
      readonly now?: number;
    }) =>
      verifyProof({
        proof: over.proof,
        htm: over.htm ?? HTM,
        htu: over.htu ?? HTU,
        accessToken: over.accessToken ?? token,
        now: over.now ?? now,
      });

    // The same proof, a different endpoint or method: that is the whole point of
    // binding it.
    expect(
      await refused(
        verify({
          proof: await proofFor({}),
          htu: 'https://pds.example/xrpc/com.atproto.repo.deleteRecord',
        }),
      ),
    ).toBe(true);
    expect(
      await refused(verify({ proof: await proofFor({}), htm: 'GET' })),
    ).toBe(true);
    // A query string is not part of `htu`, but the path is.
    expect(
      await refused(
        verify({
          proof: await proofFor({}),
          htu: 'https://pds.example/xrpc/other',
        }),
      ),
    ).toBe(true);

    // Stale, and bound to a different token.
    expect(
      await refused(verify({ proof: await proofFor({ iat: now - 3600 }) })),
    ).toBe(true);
    expect(
      await refused(
        verify({
          // The proof is bound to a *different* token than the one presented.
          proof: await proofFor({ accessToken: `${token}x` }),
          accessToken: token,
        }),
      ),
    ).toBe(true);

    // A proof that embeds a private key is refused rather than accepted, and a
    // proof with no signature of ours is not a proof.
    expect(
      await refused(
        verify({
          proof: await makeProof({
            key: client.privateKey,
            htm: HTM,
            htu: HTU,
            accessToken: token,
            iat: now,
            embedPrivateKey: true,
          }),
        }),
      ),
    ).toBe(true);
    expect(
      await refused(
        verify({
          proof: await makeProof({
            key: client.privateKey,
            htm: HTM,
            htu: HTU,
            accessToken: token,
            iat: now,
            alg: 'none',
          }),
        }),
      ),
    ).toBe(true);
    expect(await refused(verify({ proof: 'not.a.proof' }))).toBe(true);
  });
});
