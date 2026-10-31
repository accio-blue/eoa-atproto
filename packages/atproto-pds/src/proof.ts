import {
  DID,
  extractPublicKeyFromDID,
  parseSecp256k1DidKey,
} from '@eoa/crypto';
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import { type ProofKey, verifyServiceAuth } from './token.js';

/**
 * Proof of control over a DID this PDS does not host.
 *
 * An account here is normally created under a DID this PDS **mints**, and the document that resolves
 * it is one this host serves — nothing has to be proven, because the identity is the thing being
 * handed out. A **move** is the other case: a destination creates an account for a DID whose
 * document somebody *else* serves. Without a proof any caller could name any identity, which would
 * make a move a *copy*: the destination could not tell an operator moving their own account from
 * somebody claiming one.
 *
 * The proof is the service-auth token the source mints for its account
 * (`com.atproto.server.getServiceAuth`): `iss` is the DID, `aud` is the destination, and the
 * signature is checked against the key the DID's **own document** names. The key is never a claim
 * inside the token, which is the whole reason the format is worth anything.
 *
 * `did:web` is the interesting case rather than the special one: its document lives at the host the
 * DID names, so the proof is checked against the very host being claimed, and a host that serves no
 * document proves nothing.
 */

/**
 * A percent-encoded segment, as the DID spec defines one.
 *
 * Checked rather than decoded-and-caught: `decodeURIComponent` throws on a stray `%`, and a segment
 * that is not percent-encoding names no document — which is a fact worth answering, not a fault.
 */
const PERCENT_ENCODED = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})*$/;

/** Where a DID's document is served, or none when it is not a method we can resolve. */
export const didDocumentUrlOf = (params: {
  readonly did: string;
  readonly plcDirectoryUrl?: string | undefined;
}): Option.Option<string> => {
  const [method, ...rest] = params.did.split(':').slice(1);
  if (method === 'plc') {
    // A `did:plc` document is served by whichever directory the deployment names, and there is **no
    // default on purpose**: the public one is a network this repo does not control, and a closed
    // deployment that quietly asked it about an identity would be reaching the very network it exists
    // to stay out of. A deployment that wants `did:plc` proof says where to ask.
    return params.plcDirectoryUrl === undefined
      ? Option.none()
      : Option.some(`${params.plcDirectoryUrl}/${params.did}`);
  }
  if (method !== 'web') {
    return Option.none();
  }
  const [host, ...path] = rest;
  if (
    host === undefined ||
    host === '' ||
    !path.every((part) => PERCENT_ENCODED.test(part)) ||
    !PERCENT_ENCODED.test(host)
  ) {
    return Option.none();
  }
  // A `did:web:<host>:<a>:<b>` resolves at `/<a>/<b>/did.json`; the bare host resolves at
  // `/.well-known/did.json`.
  const where =
    path.length === 0
      ? '.well-known'
      : path.map((part) => decodeURIComponent(part)).join('/');
  return Option.some(`https://${decodeURIComponent(host)}/${where}/did.json`);
};

/** The little of a document a proof needs: the atproto signing key, as a multibase string. */
const DidDocumentSchema = Schema.Struct({
  verificationMethod: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        publicKeyMultibase: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/** A document as a proof reads it — parsed at the boundary, so nothing here meets raw JSON. */
export type DidDocument = Schema.Schema.Type<typeof DidDocumentSchema>;

/** A DID whose control could not be proven, and why. */
export class DidProofError extends Schema.TaggedError<DidProofError>()(
  'DidProofError',
  { reason: Schema.String },
) {}

const refuse = (reason: string) => Effect.fail(new DidProofError({ reason }));

/**
 * The key a DID signs with, taken from its own document.
 *
 * `#atproto` is the method atproto signs with, so a document that does not carry it proves nothing —
 * this refuses rather than falling back to whatever key happens to be listed first.
 */
export const atprotoKeyOf = (params: {
  readonly did: string;
  readonly document: DidDocument;
}): Effect.Effect<ProofKey, DidProofError> =>
  Effect.gen(function* () {
    const method = (params.document.verificationMethod ?? []).find(
      (one) => one.id === `${params.did}#atproto` || one.id === '#atproto',
    );
    const multibase = method?.publicKeyMultibase;
    if (multibase === undefined) {
      return yield* refuse('the document names no atproto signing key');
    }
    // A multibase key and a `did:key` differ by the prefix and nothing else, which is why this
    // reuses the did:key decoder rather than growing a second base58 implementation.
    const asKey = Schema.decodeUnknownOption(DID)(`did:key:${multibase}`);
    if (Option.isNone(asKey)) {
      return yield* refuse('the document key is not a multibase key');
    }
    const didKey = `did:key:${multibase}`;
    // The curve is read from the key, not assumed: every `did:plc` minted somewhere else names a
    // secp256k1 `#atproto` key, WebCrypto cannot hold that curve, and a P-256-only reader refused
    // exactly the identities a move arrives with. P-256 goes through WebCrypto, secp256k1 through
    // noble, and the caller verifies with whichever the document declared.
    const p256 = yield* extractPublicKeyFromDID(asKey.value).pipe(
      Effect.option,
    );
    if (Option.isSome(p256)) {
      return { curve: 'p256' as const, key: p256.value };
    }
    if (Result.isSuccess(parseSecp256k1DidKey(didKey))) {
      return { curve: 'secp256k1' as const, didKey };
    }
    return yield* refuse(
      'the document key is not one a signature can be checked against',
    );
  });

/** How a document is fetched. Injected so the rule is testable without a network. */
export type DocumentFetch = (url: string) => Promise<DidDocument>;

const liveDocumentFetch: DocumentFetch = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/did+json, application/json' },
  });
  if (!response.ok) {
    throw new Error(`the document answered ${response.status}`);
  }
  // The parse is here, at the boundary, so the rule below only ever sees a document shape it named.
  return Schema.decodeUnknownSync(DidDocumentSchema)(await response.json());
};

/**
 * Proves that whoever presents `token` controls `did`, and hands the DID back.
 *
 * The whole check is here rather than at a call site: the document is resolved from the DID alone,
 * the key comes from that document, the token has to be addressed to `audience`, and its issuer has
 * to be the DID being claimed. Any of those being off is a refusal, never a smaller claim.
 */
export const proofOfControl = (params: {
  readonly did: string;
  readonly token: string;
  /** Who the token had to be issued for: this PDS, never something the token decides. */
  readonly audience: string;
  /** The method being called. A token that names a method must name **this** one. */
  readonly lxm: string;
  readonly plcDirectoryUrl?: string | undefined;
  readonly now: number;
  readonly fetchDocument?: DocumentFetch | undefined;
}): Effect.Effect<string, DidProofError> =>
  Effect.gen(function* () {
    const url = didDocumentUrlOf({
      did: params.did,
      plcDirectoryUrl: params.plcDirectoryUrl,
    });
    if (Option.isNone(url)) {
      return yield* refuse(
        `there is no document to check an identity named ${params.did} against`,
      );
    }
    const document = yield* Effect.tryPromise({
      try: () => (params.fetchDocument ?? liveDocumentFetch)(url.value),
      catch: () =>
        new DidProofError({
          reason: `the document for ${params.did} could not be read`,
        }),
    });
    const key = yield* atprotoKeyOf({ did: params.did, document });
    const claims = yield* verifyServiceAuth({
      key,
      token: params.token,
      audience: params.audience,
      now: params.now,
    }).pipe(
      Effect.mapError((cause) => {
        // The error channel is a union: a signature that could not be checked at all is a different
        // sentence from one that checked and said no.
        const why = Predicate.isTagged(cause, 'InvalidToken')
          ? cause.reason
          : 'the signature could not be checked';
        return new DidProofError({
          reason: `the token does not prove ${params.did}: ${why}`,
        });
      }),
    );
    if (claims.iss !== params.did) {
      return yield* refuse(`the token is for ${claims.iss}, not ${params.did}`);
    }
    // A token may name the method it is good for. When it does, it has to be *this* one: a proof
    // minted to call one thing is not a proof to call another.
    if (claims.lxm !== undefined && claims.lxm !== params.lxm) {
      return yield* refuse(`the token is for ${claims.lxm}, not ${params.lxm}`);
    }
    return claims.iss;
  });
