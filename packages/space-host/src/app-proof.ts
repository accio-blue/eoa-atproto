import { Effect, Option, Schema } from 'effect';
import {
  type PrivateKey,
  type PublicKey,
  base64urlDecode,
  base64urlEncode,
  extractPublicKeyFromDID,
  sign,
  verify,
} from '@eoa/crypto';

/**
 * An approved app asking for a credential, without an account (`frxd`).
 *
 * The authority's policy names apps (`allowedApps`) and the token it mints is bound to the app's
 * key. But the app is not an account on this host and holds no session, so it cannot call the
 * endpoint the way a person would. It proves control of the key its DID publishes instead: a short
 * JWT, `iss` = the app's `did:web`, `aud` = this host, signed by that key. The host fetches the
 * document, checks the signature and the audience, and mints for `iss` — so the only thing an
 * attacker can obtain a credential for is a key they already control.
 *
 * This is deliberately *not* the spec's three-token cascade (delegation, attestation, DPoP): we run
 * the app and the space host, both ends are `did:web` with published keys, and one signed request
 * says the same thing with less machinery. A third-party app is where the cascade earns its keep.
 */

const HEADER = base64urlEncode(
  new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT' })),
);

/** What the app signs. Short-lived: an authorisation, not a session. */
export const AppProofSchema = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  iat: Schema.Finite,
  exp: Schema.Finite,
  /** The key the app will present the minted credential with; the same `jkt`. */
  jkt: Schema.String,
  /**
   * The space a **read** proof is for. Absent on the one that only asks for a credential: that
   * request names its space in the body, and the minted token is bound to it.
   */
  space: Schema.optionalKey(Schema.String),
});
export type AppProof = typeof AppProofSchema.Type;

/** How long an app's proof may live: long enough for one call, short enough to not be a session. */
export const APP_PROOF_TTL_SECONDS = 60;

/** The decoded `did:web` document, as far as this module reads it. */
const DidDocumentSchema = Schema.Struct({
  id: Schema.String,
  verificationMethod: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      publicKeyMultibase: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** Where a `did:web` document lives: its host, and the path form's segments. */
export const didWebUrlOf = (
  did: string,
): { readonly url: string } | { readonly reason: string } => {
  if (!did.startsWith('did:web:')) {
    return { reason: `${did} is not a did:web` };
  }
  const [host = '', ...path] = did.slice('did:web:'.length).split(':');
  if (host === '') {
    return { reason: `${did} names no host` };
  }
  const origin = `https://${host.replace(/%3A/gu, ':')}`;
  return {
    url:
      path.length === 0
        ? `${origin}/.well-known/did.json`
        : `${origin}/${path.join('/')}/did.json`,
  };
};

/**
 * The key a `did:web` publishes, through a fetch the caller supplies — the test seam, and the
 * reason this module never reaches the network on its own.
 */
export const resolveDidWebKey = (params: {
  readonly did: string;
  readonly fetchText: (url: string) => Effect.Effect<string, unknown>;
}): Effect.Effect<
  | { readonly ok: true; readonly key: PublicKey }
  | { readonly ok: false; readonly reason: string }
> =>
  Effect.gen(function* () {
    const where = didWebUrlOf(params.did);
    if ('reason' in where) {
      return { ok: false as const, reason: where.reason };
    }
    const body = yield* params
      .fetchText(where.url)
      .pipe(
        Effect.catch(() => Effect.succeed(undefined as string | undefined)),
      );
    if (body === undefined) {
      return { ok: false as const, reason: `${where.url} is not reachable` };
    }
    const document = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(DidDocumentSchema))(
        body,
      ),
    );
    if (document === undefined) {
      return {
        ok: false as const,
        reason: `${where.url} is not a DID document`,
      };
    }
    // A document that describes another DID is not this one's, however well it is signed.
    if (document.id !== params.did) {
      return {
        ok: false as const,
        reason: `${where.url} describes ${document.id}, not ${params.did}`,
      };
    }
    const multibase = document.verificationMethod.find((method) =>
      method.id.endsWith('#atproto'),
    )?.publicKeyMultibase;
    if (multibase === undefined) {
      return {
        ok: false as const,
        reason: `${params.did} publishes no #atproto key`,
      };
    }
    const key = yield* extractPublicKeyFromDID(
      `did:key:${multibase}` as never,
    ).pipe(
      Effect.mapError(() => ({
        ok: false as const,
        reason: `${params.did}'s #atproto key does not import`,
      })),
    );
    return { ok: true as const, key };
  }).pipe(
    // A failure is an answer here: the caller wants to know why an app cannot be verified.
    Effect.catch((error) =>
      Effect.succeed({ ok: false as const, reason: error.reason }),
    ),
  );

/** Mint a proof, as the app would. Exported so a deployment and its tests sign identically. */
export const signAppProof = (params: {
  readonly app: string;
  readonly audience: string;
  readonly jkt: string;
  readonly now: number;
  readonly key: PrivateKey;
  readonly ttl?: number | undefined;
  /** Set on a read proof, so a captured one opens only the space it was made for. */
  readonly space?: string | undefined;
}): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const iat = Math.floor(params.now / 1000);
    const body = base64urlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          iss: params.app,
          aud: params.audience,
          iat,
          exp: iat + (params.ttl ?? APP_PROOF_TTL_SECONDS),
          jkt: params.jkt,
          ...(params.space === undefined ? {} : { space: params.space }),
        }),
      ),
    );
    const signed = `${HEADER}.${body}`;
    const signature = yield* sign(
      params.key,
      new TextEncoder().encode(signed),
    ).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())));
    return `${signed}.${base64urlEncode(signature)}`;
  });

export type AppProofVerdict =
  | { readonly ok: true; readonly proof: AppProof; readonly jkt: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Check what an app signed: the header is ours, the key is the one its DID publishes, the audience
 * is this host, and it has not expired. Nothing about the *space* is decided here — the policy
 * remains the authority's.
 */
export const verifyAppProof = (params: {
  readonly proof: string;
  readonly key: PublicKey;
  readonly audience: string;
  readonly now: number;
  /** When set, the proof has to name exactly this space — a read proof is not a master key. */
  readonly space?: string | undefined;
}): Effect.Effect<AppProofVerdict> =>
  Effect.gen(function* () {
    const [header, body, signature] = params.proof.split('.');
    if (header === undefined || body === undefined || signature === undefined) {
      return { ok: false as const, reason: 'not a proof' };
    }
    if (header !== HEADER) {
      return { ok: false as const, reason: 'not a proof we issue' };
    }
    const genuine = yield* verify(
      params.key,
      new TextEncoder().encode(`${header}.${body}`),
      base64urlDecode(signature),
    ).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!genuine) {
      return { ok: false as const, reason: 'the signature does not verify' };
    }
    const proof = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(AppProofSchema))(
        new TextDecoder().decode(base64urlDecode(body)),
      ),
    );
    if (proof === undefined) {
      return { ok: false as const, reason: 'the proof does not parse' };
    }
    if (proof.aud !== params.audience) {
      return { ok: false as const, reason: 'not for this host' };
    }
    if (params.space !== undefined && proof.space !== params.space) {
      return { ok: false as const, reason: 'not for this space' };
    }
    if (proof.exp <= Math.floor(params.now / 1000)) {
      return { ok: false as const, reason: 'expired' };
    }
    return { ok: true as const, proof, jkt: proof.jkt };
  });

/**
 * The app a proof claims to be, **without verifying it**.
 *
 * The key that verifies a proof is the one its `iss` publishes, so the claim has to be read before
 * anything can be checked — this answers only "whose key do I fetch", and a forged claim leads to a
 * signature check against the wrong key, which fails.
 */
export const appOfProofUnverified = (proof: string): string | undefined => {
  const body = proof.split('.')[1];
  if (body === undefined) {
    return undefined;
  }
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(AppProofSchema))(
      new TextDecoder().decode(base64urlDecode(body)),
    ),
  );
  return decoded?.iss;
};
