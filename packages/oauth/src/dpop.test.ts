import { DpopError, createProof, verifyProof } from './dpop.js';
import { Effect, Schema } from 'effect';
import {
  type PrivateKey,
  base64urlEncode,
  exportPublicKey,
  generateES256KeyPair,
  sha256,
} from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { segmentFor, signJwt, splitJwt } from './jwt.js';

const TEXT_ENCODER = new TextEncoder();

const HMT = 'POST';
const HTU = 'https://pds.example/xrpc/com.atproto.repo.createRecord';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const makeKey = () => Effect.runPromise(generateES256KeyPair());

const ExportedJwkSchema = Schema.Struct({
  kty: Schema.String,
  crv: Schema.String,
  x: Schema.String,
  y: Schema.String,
});

/** The public half, as it appears in a proof header. */
const publicJwk = async (key: PrivateKey) => {
  const exported = await Effect.runPromise(exportPublicKey(key.publicKey));
  return await Effect.runPromise(
    Effect.fromOption(
      Schema.decodeUnknownOption(ExportedJwkSchema)(exported),
      () =>
        new DpopError({ message: 'the exported key is not an EC public JWK' }),
    ),
  );
};

/*
 * A deliberately looser header than the module accepts, so a test can build the
 * proofs a real client never would: a wrong `typ`, a claimed algorithm, a leaked
 * private key.
 */
const CraftedHeaderSchema = Schema.Struct({
  typ: Schema.String,
  alg: Schema.String,
  jwk: Schema.Struct({
    kty: Schema.String,
    crv: Schema.String,
    x: Schema.String,
    y: Schema.String,
    d: Schema.optionalKey(Schema.String),
  }),
});

const CraftedPayloadSchema = Schema.Struct({
  jti: Schema.String,
  htm: Schema.String,
  htu: Schema.String,
  iat: Schema.Finite,
});

type CraftedHeader = Schema.Schema.Type<typeof CraftedHeaderSchema>;
type CraftedPayload = Schema.Schema.Type<typeof CraftedPayloadSchema>;

const claim = (params: {
  readonly htm?: string;
  readonly htu?: string;
  readonly iat?: number;
}): CraftedPayload => ({
  jti: 'a-crafted-jti',
  htm: params.htm ?? HMT,
  htu: params.htu ?? HTU,
  iat: params.iat ?? nowSeconds(),
});

/** Craft a proof by hand, so a test can make one the encoder never would. */
const craft = (params: {
  readonly key: PrivateKey;
  readonly header: CraftedHeader;
  readonly payload: CraftedPayload;
}) =>
  Effect.runPromise(
    signJwt({
      key: params.key,
      headerSegment: segmentFor({
        codec: Schema.fromJsonString(CraftedHeaderSchema),
        value: params.header,
      }),
      payloadSegment: segmentFor({
        codec: Schema.fromJsonString(CraftedPayloadSchema),
        value: params.payload,
      }),
    }),
  );

const verify = (proof: string) =>
  Effect.runPromise(
    verifyProof({ proof, htm: HMT, htu: HTU, now: nowSeconds() }),
  );

describe('DPoP proofs', () => {
  it('round-trips a proof the client made, and reports the RFC 7638 thumbprint', async () => {
    const key = await makeKey();
    const proof = await Effect.runPromise(
      createProof({ key: key.privateKey, htm: HMT, htu: HTU }),
    );

    const verified = await verify(proof);

    // The thumbprint, computed independently of the module: the canonical JSON
    // RFC 7638 fixes, written out by hand over exactly those members in that
    // order.
    const jwk = await publicJwk(key.privateKey);
    const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expected = base64urlEncode(
      await Effect.runPromise(sha256(TEXT_ENCODER.encode(canonical))),
    );

    expect(verified.jkt).toBe(expected);
    expect(verified.jti).toBeTruthy();
    expect(verified.iat).toBeLessThanOrEqual(nowSeconds());
  });

  it('gives different keys different thumbprints', async () => {
    const [a, b] = await Promise.all([makeKey(), makeKey()]);
    const proofFor = (key: PrivateKey) =>
      Effect.runPromise(createProof({ key, htm: HMT, htu: HTU }));

    const [one, two] = await Promise.all([
      verify(await proofFor(a.privateKey)),
      verify(await proofFor(b.privateKey)),
    ]);

    expect(one.jkt).not.toBe(two.jkt);
  });

  it('binds the proof to the method and the URI', async () => {
    const key = await makeKey();
    const proof = await Effect.runPromise(
      createProof({ key: key.privateKey, htm: HMT, htu: HTU }),
    );

    await expect(
      Effect.runPromise(
        verifyProof({ proof, htm: 'GET', htu: HTU, now: nowSeconds() }),
      ),
    ).rejects.toThrow(/the proof is for POST, not GET/);

    await expect(
      Effect.runPromise(
        verifyProof({
          proof,
          htm: HMT,
          htu: 'https://pds.example/xrpc/com.atproto.repo.putRecord',
          now: nowSeconds(),
        }),
      ),
    ).rejects.toThrow(/the proof is for .*createRecord, not .*putRecord/);
  });

  it('ignores a query string, which is not part of htu (RFC 9449 §4.3)', async () => {
    const key = await makeKey();
    const proof = await Effect.runPromise(
      createProof({ key: key.privateKey, htm: HMT, htu: HTU }),
    );

    const verified = await Effect.runPromise(
      verifyProof({
        proof,
        htm: 'post',
        htu: `${HTU}?repo=did:plc:abc#frag`,
        now: nowSeconds(),
      }),
    );

    expect(verified.jti).toBeTruthy();
  });

  it('rejects a proof whose payload was swapped for another request', async () => {
    const key = await makeKey();
    const forThis = await Effect.runPromise(
      createProof({ key: key.privateKey, htm: HMT, htu: HTU }),
    );
    const forElsewhere = await Effect.runPromise(
      createProof({
        key: key.privateKey,
        htm: HMT,
        htu: 'https://evil.example/xrpc/com.atproto.repo.createRecord',
      }),
    );

    // A valid proof's header and signature, carrying another proof's payload: the
    // signature covers the body, so this is a forgery and must read like one.
    const { header, signature } = await Effect.runPromise(splitJwt(forThis));
    const { body } = await Effect.runPromise(splitJwt(forElsewhere));

    await expect(verify(`${header}.${body}.${signature}`)).rejects.toThrow(
      /signature does not match the key/,
    );
  });

  it('rejects a proof whose header only claims ES256', async () => {
    const key = await makeKey();
    const proof = await craft({
      key: key.privateKey,
      header: {
        typ: 'dpop+jwt',
        alg: 'HS256',
        jwk: await publicJwk(key.privateKey),
      },
      payload: claim({}),
    });

    await expect(verify(proof)).rejects.toThrow(/verifies ES256 only/);
  });

  it('rejects a JWT that does not claim to be a DPoP proof', async () => {
    const key = await makeKey();
    const proof = await craft({
      key: key.privateKey,
      header: {
        typ: 'JWT',
        alg: 'ES256',
        jwk: await publicJwk(key.privateKey),
      },
      payload: claim({}),
    });

    await expect(verify(proof)).rejects.toThrow(/not a DPoP JWS header/);
  });

  it('rejects a proof that embeds a private key', async () => {
    const key = await makeKey();
    const proof = await craft({
      key: key.privateKey,
      header: {
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: { ...(await publicJwk(key.privateKey)), d: 'leaked' },
      },
      payload: claim({}),
    });

    await expect(verify(proof)).rejects.toThrow(/embeds a private key/);
  });

  it('rejects a signature made with a different key than the header names', async () => {
    const [signer, named] = await Promise.all([makeKey(), makeKey()]);
    const proof = await craft({
      key: signer.privateKey,
      header: {
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: await publicJwk(named.privateKey),
      },
      payload: claim({}),
    });

    await expect(verify(proof)).rejects.toThrow(
      /signature does not match the key/,
    );
  });

  it('rejects a stale proof, and accepts it inside the window', async () => {
    const key = await makeKey();
    const proof = await Effect.runPromise(
      createProof({
        key: key.privateKey,
        htm: HMT,
        htu: HTU,
        iat: nowSeconds() - 3600,
      }),
    );

    await expect(verify(proof)).rejects.toThrow(/not fresh/);

    await expect(
      Effect.runPromise(
        verifyProof({ proof, htm: HMT, htu: HTU, now: nowSeconds() - 3590 }),
      ),
    ).resolves.toBeTruthy();
  });

  it('requires the nonce the server last issued, once it has challenged', async () => {
    const key = await makeKey();
    const proof = (nonce: string | undefined) =>
      Effect.runPromise(
        createProof({
          key: key.privateKey,
          htm: HMT,
          htu: HTU,
          ...(nonce === undefined ? {} : { nonce }),
        }),
      );
    const challenged = (params: {
      readonly proof: string;
      readonly expectedNonce: string;
    }) =>
      Effect.runPromise(
        verifyProof({
          proof: params.proof,
          htm: HMT,
          htu: HTU,
          now: nowSeconds(),
          expectedNonce: params.expectedNonce,
        }),
      );

    // no nonce challenged yet: a proof without one is fine
    await expect(verify(await proof(undefined))).resolves.toBeTruthy();

    // challenged: a proof without one, or with a stale one, is not
    await expect(
      challenged({ proof: await proof(undefined), expectedNonce: 'nonce-1' }),
    ).rejects.toThrow(/current nonce/);
    await expect(
      challenged({ proof: await proof('nonce-0'), expectedNonce: 'nonce-1' }),
    ).rejects.toThrow(/current nonce/);
    await expect(
      challenged({ proof: await proof('nonce-1'), expectedNonce: 'nonce-1' }),
    ).resolves.toBeTruthy();
  });

  it('binds a resource proof to the access token it travels with', async () => {
    const key = await makeKey();
    const token = 'an-access-token';
    const bound = await Effect.runPromise(
      createProof({
        key: key.privateKey,
        htm: HMT,
        htu: HTU,
        accessToken: token,
      }),
    );
    const withToken = (params: {
      readonly proof: string;
      readonly accessToken: string;
    }) =>
      Effect.runPromise(
        verifyProof({
          proof: params.proof,
          htm: HMT,
          htu: HTU,
          now: nowSeconds(),
          accessToken: params.accessToken,
        }),
      );

    await expect(
      withToken({ proof: bound, accessToken: token }),
    ).resolves.toBeTruthy();
    await expect(
      withToken({ proof: bound, accessToken: 'another-token' }),
    ).rejects.toThrow(/not bound to this access token/);

    // a bearer-style proof cannot stand in for a bound one
    const tokenless = await Effect.runPromise(
      createProof({ key: key.privateKey, htm: HMT, htu: HTU }),
    );
    await expect(
      withToken({ proof: tokenless, accessToken: token }),
    ).rejects.toThrow(/not bound to this access token/);
  });
});
