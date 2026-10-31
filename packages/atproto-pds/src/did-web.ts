import {
  CryptoError,
  DID,
  type DIDDocument,
  type PrivateKey,
  createDIDKey,
} from '@eoa/crypto';
import { Effect, Option, Schema } from 'effect';

/**
 * The document a `did:web` identity resolves to: the host's own statement of who it is.
 *
 * `did:web` has no directory. The DID *is* the domain, and a resolver fetches
 * `https://<domain>/.well-known/did.json` to learn what it signs with and where its PDS is — so
 * the document is small, and it is the entire registry. That is the trade the method makes:
 * nothing to submit, and nothing to move if the host ever changes.
 *
 * The key is written the way atproto writes it — `Multikey` with the `publicKeyMultibase` part of
 * the signing key's `did:key` — rather than as a JWK, because whoever resolves this DID verifies
 * repos with the key the PDS signs them with, and that is the encoding it expects to find.
 */
/**
 * The host a `did:web` document can be served from: the PDS's own, from its public URL.
 *
 * `did:web:<host>:<id>` resolves at `https://<host>/<id>/did.json`, so the host has to be a name
 * this PDS answers on. The handle's domain is not: it is where *handles* live, and its apex belongs
 * to whoever runs the site — which is how accounts came to have identities nothing served. A
 * deployment that has named no public URL has told us nothing about where documents live, and gets
 * the handle domain back rather than a guess.
 */
export const documentHostOf = (config: {
  readonly publicUrl?: string | undefined;
  readonly domain: string;
}) => {
  const url = config.publicUrl;
  if (url === undefined || url === '') {
    return config.domain;
  }
  try {
    return new URL(url).host || config.domain;
  } catch {
    return config.domain;
  }
};

/**
 * The DID a request path asks about, or nothing when the path is not one.
 *
 * A path-based `did:web` — `did:web:<host>:<id>` — belongs at `https://<host>/<id>/did.json`: one
 * segment, then the file name the method fixes. The host's *own* document is `/.well-known/did.json`
 * and is not this; nor is a nested path, because `did:web` carries one segment of path and reading
 * more out of a URL than the method puts into it is how a resolver gets confused.
 */
export const didWebPathOf = (params: {
  readonly path: string;
  readonly host: string;
}): Option.Option<string> => {
  const match = /^\/([^/]+)\/did\.json$/u.exec(params.path);
  const id = match?.[1];
  // A segment that starts with a dot is not an id this PDS mints — `randomId` is base64url — and
  // `/.well-known/did.json` is the host's *own* document, which this must not swallow. Reading it
  // as an account path answers a resolver's first question with a 404.
  if (id === undefined || id.startsWith('.')) {
    return Option.none();
  }
  try {
    return Option.some(`did:web:${params.host}:${decodeURIComponent(id)}`);
  } catch {
    // A path segment that is not valid percent-encoding names no DID.
    return Option.none();
  }
};

export const didWebDocumentOf = (params: {
  readonly did: string;
  /** Where the PDS answers, e.g. `https://pds.example`. What the service points at. */
  readonly endpoint: string;
  readonly signingKey: PrivateKey;
  /**
   * The account's `#atproto_kem` key, when this host holds one.
   *
   * A `did:web` document is the account's only registry, so the key a syncer encapsulates against
   * has to be here: there is no PLC operation to publish it in (spaces alpha, 2026-10-22, §7).
   */
  readonly kemKey?: string | undefined;
}): Effect.Effect<DIDDocument, CryptoError> =>
  Effect.gen(function* () {
    const id = Schema.decodeSync(DID)(params.did);
    const key = yield* createDIDKey(params.signingKey.publicKey);

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1',
      ],
      id,
      verificationMethod: [
        {
          id: `${params.did}#atproto`,
          type: 'Multikey',
          controller: id,
          publicKeyMultibase: key.replace(/^did:key:/, ''),
        },
        ...(params.kemKey === undefined
          ? []
          : [
              {
                id: `${params.did}#atproto_kem`,
                type: 'Multikey' as const,
                controller: id,
                publicKeyMultibase: params.kemKey.replace(/^did:key:/, ''),
              },
            ]),
      ],
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: params.endpoint,
        },
      ],
    };
  });
