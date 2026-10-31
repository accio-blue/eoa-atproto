import {
  type CryptoError,
  compressPoint,
  formatP256DidKey,
  generateP256SecretKey,
  hkdfSha256,
  importablePointFromDidKey,
  p256PublicPoint,
  p256SharedSecret,
} from '@eoa/crypto';
import { Effect } from 'effect';
import { concatBytes } from '@eoa/core';

/**
 * The shared secret a space commit or record is authenticated with (spaces alpha, 2026-10-22,
 * section 4c).
 *
 * Commits stopped carrying a signature: instead the syncer and the repo host agree on a secret for
 * one request, and the repo host answers with an HMAC under it. So a leaked response proves nothing
 * about authorship to a third party, which is the point — permissioned data is meant to be
 * deniable.
 *
 * The agreement is DHKEM(P-256, HKDF-SHA256) from RFC 9180 §4.1, with no HPKE encryption layered on
 * top: the syncer makes an ephemeral P-256 keypair per request (and per page), ECDH against the
 * author's published `#atproto_kem` key, and sends its ephemeral public key as a `did:key` in the
 * request header. The repo host does the same ECDH with the author's private key. Both sides then
 * derive the same 32 bytes from the x-coordinate.
 *
 * A fresh keypair per request is not a nicety: a reused ephemeral key would let two responses be
 * tied to one secret, and the MACs would stop being request-scoped.
 */

/** The x-coordinate of a P-256 shared point: what the derivation consumes. */
const SHARED_SECRET_BYTES = 32;

const encoder = new TextEncoder();

const HPKE_VERSION_LABEL = encoder.encode('HPKE-v1');
const KEM_LABEL = encoder.encode('KEM');

/** `uint16be(0x0010)`: the KEM suite id of DHKEM(P-256, HKDF-SHA256). */
const KEM_SUITE_ID = Uint8Array.from([0x00, 0x10]);

const EAE_PRK_LABEL = encoder.encode('eae_prk');
const SHARED_SECRET_LABEL = encoder.encode('shared_secret');

const uint16be = (value: number): Uint8Array =>
  Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);

/** A P-256 keypair whose public half is the uncompressed SEC1 point. */
export interface SpaceKemKeyPair {
  /** 32-byte secret scalar; never leaves the repo host. */
  readonly secretKey: Uint8Array;
  /** 65-byte uncompressed point. */
  readonly publicKey: Uint8Array;
}

export interface Encapsulation {
  /** The ephemeral public key as a `did:key`, which is what the request header carries. */
  readonly keyShare: string;
  readonly sharedSecret: Uint8Array;
}

/** A dedicated KEM keypair for an account: not the `#atproto` signing key. */
export const generateKemKeyPair = (): Effect.Effect<
  SpaceKemKeyPair,
  CryptoError
> =>
  Effect.gen(function* () {
    const secretKey = yield* generateP256SecretKey();
    const publicKey = yield* p256PublicPoint(secretKey);
    return { secretKey, publicKey };
  });

/** The `#atproto_kem` verification method's value: a P-256 `did:key`. */
export const kemKeyDidKey = (
  publicKey: Uint8Array,
): Effect.Effect<string, CryptoError> =>
  Effect.try({
    try: () => formatP256DidKey(compressPoint(publicKey)),
    catch: (cause) => ({ _tag: 'CryptoError' as const, cause }) as CryptoError,
  });

/**
 * The per-request derivation from RFC 9180 §4.1. Both sides feed the same two points — the
 * syncer's ephemeral one first — and the same DH result, so both get the same secret.
 */
const derive = (params: {
  readonly dh: Uint8Array;
  readonly keySharePoint: Uint8Array;
  readonly recipientPoint: Uint8Array;
}): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.gen(function* () {
    const suite = concatBytes([HPKE_VERSION_LABEL, KEM_LABEL, KEM_SUITE_ID]);
    // LabeledExtract: "HPKE-v1" || suite_id || "eae_prk" || dh, with an empty salt. WebCrypto's
    // HKDF does extract and expand in one call, so the extract half is this input.
    const ikm = concatBytes([suite, EAE_PRK_LABEL, params.dh]);
    // LabeledExpand: the length prefix comes from the DHKEM spec, then the same suite id, then the
    // label and the two uncompressed points.
    const info = concatBytes([
      uint16be(SHARED_SECRET_BYTES),
      suite,
      SHARED_SECRET_LABEL,
      params.keySharePoint,
      params.recipientPoint,
    ]);
    return yield* hkdfSha256({
      ikm,
      salt: new Uint8Array(),
      info,
      length: SHARED_SECRET_BYTES,
    });
  });

/**
 * The syncer's half: against the author's published `#atproto_kem` key, with a fresh ephemeral
 * keypair for this one request.
 */
export const encapsulate = (
  authorKemKey: string,
): Effect.Effect<Encapsulation, CryptoError> =>
  Effect.gen(function* () {
    const authorPoint = yield* importablePointFromDidKey(authorKemKey);
    const ephemeral = yield* generateKemKeyPair();
    const dh = yield* p256SharedSecret({
      secretKey: ephemeral.secretKey,
      publicKey: authorPoint,
    });
    return {
      keyShare: yield* kemKeyDidKey(ephemeral.publicKey),
      sharedSecret: yield* derive({
        dh,
        keySharePoint: ephemeral.publicKey,
        recipientPoint: authorPoint,
      }),
    };
  });

/**
 * The repo host's half: the same derivation with the account's private KEM key and the ephemeral
 * point from the request header.
 */
export const decapsulate = (params: {
  readonly keyPair: SpaceKemKeyPair;
  readonly keyShare: string;
}): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.gen(function* () {
    const keySharePoint = yield* importablePointFromDidKey(params.keyShare);
    const dh = yield* p256SharedSecret({
      secretKey: params.keyPair.secretKey,
      publicKey: keySharePoint,
    });
    return yield* derive({
      dh,
      keySharePoint,
      recipientPoint: params.keyPair.publicKey,
    });
  });
