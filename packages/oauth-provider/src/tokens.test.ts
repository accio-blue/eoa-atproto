import {
  type AccessTokenClaims,
  AccessTokenError,
  type Principal,
  authenticateRequest,
  issueAccessToken,
  verifyAccessToken,
} from './tokens.js';
import { Effect, Schema } from 'effect';
import { type PrivateKey, generateES256KeyPair } from '@eoa/crypto';
import { type TokenKeysShape, generateTokenKeys } from './keys.js';
import {
  createProof,
  dpopKeyThumbprint,
  segmentFor,
  signJwt,
  valueFrom,
} from '@eoa/oauth';
import { describe, expect, it } from 'vitest';

/**
 * The token authority. What is worth testing here is the *binding*: a token is only
 * good with a proof from the key it names, so every test that presents a token with
 * the wrong proof is the one that matters.
 *
 * The helpers hang off the environment, one argument each, so the signing key, the
 * DPoP key and the confirmation travel together and a test cannot mix two accounts.
 */

const ISSUER = 'https://auth.example';
const AUDIENCE = 'https://pds.example';
const DID = 'did:plc:alice';
const CREDENTIAL = 'phone';
const SCOPE = 'atproto';
const HTU = 'https://pds.example/xrpc/com.atproto.repo.createRecord';
const HMT = 'POST';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface IssueOverrides {
  readonly did?: string;
  readonly scope?: string;
  readonly credential?: string;
  readonly jkt?: string;
  readonly now?: number;
  readonly ttlSeconds?: number;
  readonly issuer?: string;
  readonly audience?: string;
}

interface Env {
  readonly keys: TokenKeysShape;
  readonly dpopKey: PrivateKey;
  readonly jkt: string;
  readonly issue: (overrides: IssueOverrides) => Promise<string>;
  readonly verify: (params: {
    readonly token: string;
    readonly now?: number;
    readonly issuer?: string;
    readonly audience?: string;
  }) => Promise<AccessTokenClaims>;
  readonly proof: (params: {
    readonly key?: PrivateKey;
    readonly token?: string;
    readonly htm?: string;
    readonly htu?: string;
  }) => Promise<string>;
  readonly authenticate: (params: {
    readonly token: string;
    readonly proof: string;
    readonly htm?: string;
    readonly htu?: string;
    readonly now?: number;
  }) => Promise<Principal>;
}

const makeEnv = async (): Promise<Env> => {
  const keys = await Effect.runPromise(generateTokenKeys);
  const dpop = await Effect.runPromise(generateES256KeyPair());
  const jkt = await Effect.runPromise(dpopKeyThumbprint(dpop.privateKey));

  return {
    keys,
    dpopKey: dpop.privateKey,
    jkt,
    issue: (overrides) =>
      Effect.runPromise(
        issueAccessToken({
          keys,
          issuer: overrides.issuer ?? ISSUER,
          audience: overrides.audience ?? AUDIENCE,
          did: overrides.did ?? DID,
          scope: overrides.scope ?? SCOPE,
          credential: overrides.credential ?? CREDENTIAL,
          jkt: overrides.jkt ?? jkt,
          now: overrides.now ?? nowSeconds(),
          ...(overrides.ttlSeconds === undefined
            ? {}
            : { ttlSeconds: overrides.ttlSeconds }),
        }),
      ),
    verify: (params) =>
      Effect.runPromise(
        verifyAccessToken({
          keys,
          token: params.token,
          issuer: params.issuer ?? ISSUER,
          audience: params.audience ?? AUDIENCE,
          now: params.now ?? nowSeconds(),
        }),
      ),
    proof: (params) =>
      Effect.runPromise(
        createProof({
          key: params.key ?? dpop.privateKey,
          htm: params.htm ?? HMT,
          htu: params.htu ?? HTU,
          ...(params.token === undefined ? {} : { accessToken: params.token }),
        }),
      ),
    authenticate: (params) =>
      Effect.runPromise(
        authenticateRequest({
          keys,
          token: params.token,
          proof: params.proof,
          htm: params.htm ?? HMT,
          htu: params.htu ?? HTU,
          now: params.now ?? nowSeconds(),
          issuer: ISSUER,
          audience: AUDIENCE,
        }),
      ),
  };
};

/*
 * A deliberately looser pair of schemas, so a test can sign the tokens a real client
 * never would: a claimed algorithm, an odd `typ`, a missing key binding.
 */
const CraftedHeaderSchema = Schema.Struct({
  alg: Schema.String,
  typ: Schema.String,
  kid: Schema.String,
});
const CraftedPayloadSchema = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  scope: Schema.String,
  iat: Schema.Finite,
  exp: Schema.Finite,
  jti: Schema.String,
  cnf: Schema.optionalKey(Schema.Struct({ jkt: Schema.String })),
});

interface CraftedParams {
  readonly key: PrivateKey;
  readonly header: Schema.Schema.Type<typeof CraftedHeaderSchema>;
  readonly payload: Schema.Schema.Type<typeof CraftedPayloadSchema>;
}

const craft = (params: CraftedParams) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const headerSegment = segmentFor({
        codec: Schema.fromJsonString(CraftedHeaderSchema),
        value: params.header,
      });
      const payloadSegment = segmentFor({
        codec: Schema.fromJsonString(CraftedPayloadSchema),
        value: params.payload,
      });
      return yield* signJwt({
        headerSegment,
        payloadSegment,
        key: params.key,
      });
    }),
  );

/** The claims a crafted token starts from. */
const claim = (env: Env) => {
  const now = nowSeconds();
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: DID,
    scope: SCOPE,
    iat: now,
    exp: now + 3600,
    jti: 'a-crafted-jti',
    cnf: { jkt: env.jkt },
  };
};

const AccessTokenHeader = Schema.Struct({
  kid: Schema.String,
  alg: Schema.String,
  typ: Schema.String,
});

describe('the provider token authority', () => {
  it('issues a token that verifies, carrying the DID, scope and key', async () => {
    const env = await makeEnv();
    const token = await env.issue({ did: DID, scope: SCOPE });

    const claims = await env.verify({ token });

    expect(claims.sub).toBe(DID);
    expect(claims.scope).toBe(SCOPE);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.cnf.jkt).toBe(env.jkt);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it('names its key in the header, and publishes that key without its private half', async () => {
    const env = await makeEnv();
    const token = await env.issue({});

    const header = await Effect.runPromise(
      valueFrom({
        schema: AccessTokenHeader,
        segment: token.split('.')[0]!,
        message: 'the header is not an access token header',
      }),
    );
    expect(header.kid).toBe(env.keys.kid);
    expect(header.alg).toBe('ES256');
    expect(header.typ).toBe('at+jwt');

    expect(env.keys.jwks.keys).toHaveLength(1);
    const jwk = env.keys.jwks.keys[0]!;
    expect(jwk.kid).toBe(env.keys.kid);
    expect(jwk.use).toBe('sig');
    expect(jwk.alg).toBe('ES256');
    expect(Object.keys(jwk)).not.toContain('d');
  });

  it('refuses a token addressed elsewhere, from elsewhere, or out of time', async () => {
    const env = await makeEnv();

    await expect(
      env.verify({
        token: await env.issue({}),
        audience: 'https://other.example',
      }),
    ).rejects.toThrow(/not to us/);
    await expect(
      env.verify({
        token: await env.issue({}),
        issuer: 'https://other.example',
      }),
    ).rejects.toThrow(/not by us/);

    const stale = await env.issue({ now: nowSeconds() - 7200, ttlSeconds: 60 });
    await expect(env.verify({ token: stale })).rejects.toThrow(/has expired/);
  });

  it('refuses a payload that was swapped for another token', async () => {
    const env = await makeEnv();
    const one = await env.issue({});
    const two = await env.issue({ scope: 'atproto transition:generic' });

    const parts = one.split('.');
    const other = two.split('.');
    const spliced = `${parts[0]}.${other[1]}.${parts[2]}`;

    await expect(env.verify({ token: spliced })).rejects.toThrow(
      /signature does not match the key/,
    );
  });

  it('refuses a header that only claims ES256, or is not an access token', async () => {
    const env = await makeEnv();

    const claimed = await craft({
      key: env.keys.privateKey,
      header: { alg: 'HS256', typ: 'at+jwt', kid: env.keys.kid },
      payload: claim(env),
    });
    await expect(env.verify({ token: claimed })).rejects.toThrow(
      /verifies ES256 only/,
    );

    const wrongType = await craft({
      key: env.keys.privateKey,
      header: { alg: 'ES256', typ: 'JWT', kid: env.keys.kid },
      payload: claim(env),
    });
    await expect(env.verify({ token: wrongType })).rejects.toThrow(
      /not an access token header/,
    );
  });

  it('refuses a token signed with a key it does not hold', async () => {
    const env = await makeEnv();
    const stranger = await Effect.runPromise(generateTokenKeys);

    const foreignKid = await craft({
      key: env.keys.privateKey,
      header: { alg: 'ES256', typ: 'at+jwt', kid: stranger.kid },
      payload: claim(env),
    });
    await expect(env.verify({ token: foreignKid })).rejects.toThrow(
      /key we do not hold/,
    );

    // a token signed by another provider, honestly claiming the kid we do hold
    const otherKeys = await Effect.runPromise(generateTokenKeys);
    const foreign = await craft({
      key: otherKeys.privateKey,
      header: { alg: 'ES256', typ: 'at+jwt', kid: env.keys.kid },
      payload: claim(env),
    });
    await expect(env.verify({ token: foreign })).rejects.toThrow(
      /signature does not match the key/,
    );
  });

  it('refuses a token that is not bound to a key at all', async () => {
    const env = await makeEnv();
    const { cnf: _dropped, ...unbound } = claim(env);
    const token = await craft({
      key: env.keys.privateKey,
      header: { alg: 'ES256', typ: 'at+jwt', kid: env.keys.kid },
      payload: unbound,
    });

    await expect(env.verify({ token })).rejects.toThrow(
      /not an access token claim/,
    );
  });

  it('authenticates a signed request: a token and a proof from its key', async () => {
    const env = await makeEnv();
    const token = await env.issue({});
    const proof = await env.proof({ token });

    const principal = await env.authenticate({ token, proof });

    expect(principal.did).toBe(DID);
    expect(principal.scope).toBe(SCOPE);
    // the credential travels with the token, so a resource server can re-check it
    expect(principal.credential).toBe(CREDENTIAL);
    expect(principal.jkt).toBe(env.jkt);
    expect(principal.jti).toBeTruthy();
  });

  it('refuses a proof from a key the token is not bound to', async () => {
    const env = await makeEnv();
    // a second client, with a token of its own that is honestly bound to it
    const other = await Effect.runPromise(generateES256KeyPair());
    const otherJkt = await Effect.runPromise(
      dpopKeyThumbprint(other.privateKey),
    );
    const mallorys = await env.issue({ jkt: otherJkt, did: 'did:plc:mallory' });

    const malloryProof = await env.proof({
      key: other.privateKey,
      token: mallorys,
    });
    await expect(
      env.authenticate({ token: mallorys, proof: malloryProof }),
    ).resolves.toMatchObject({ did: 'did:plc:mallory' });

    // but each proof only opens the token it was made for
    const aliceToken = await env.issue({});
    const aliceProof = await env.proof({ token: aliceToken });
    await expect(
      env.authenticate({ token: mallorys, proof: aliceProof }),
    ).rejects.toThrow(/not bound to this access token/);
    await expect(
      env.authenticate({ token: aliceToken, proof: malloryProof }),
    ).rejects.toThrow(/not bound to this access token/);
  });

  it('refuses a proof for another request, and one without the token', async () => {
    const env = await makeEnv();
    const token = await env.issue({});

    const wrongUri = await env.proof({ token, htu: `${HTU}Elsewhere` });
    await expect(env.authenticate({ token, proof: wrongUri })).rejects.toThrow(
      /the proof is for/,
    );

    // a bearer-style proof: made without the access token, so it carries no `ath`
    const tokenless = await env.proof({});
    await expect(env.authenticate({ token, proof: tokenless })).rejects.toThrow(
      /not bound to this access token/,
    );
  });

  it('propagates an expired token through the request boundary', async () => {
    const env = await makeEnv();
    const token = await env.issue({ now: nowSeconds() - 7200, ttlSeconds: 60 });
    const proof = await env.proof({ token });

    await expect(env.authenticate({ token, proof })).rejects.toBeInstanceOf(
      AccessTokenError,
    );
  });
});
