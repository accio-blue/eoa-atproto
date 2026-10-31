import { Context, Effect, Layer, Option, Schema } from 'effect';

import type { DID } from '@eoa/core';
import { HandleNotFoundError } from './types.js';

// Handle resolution adapters, per the atproto handle spec: DNS TXT at
// `_atproto.<handle>` (value `did=…`), with `https://<handle>/.well-known/atproto-did`
// as the HTTPS fallback. Transport is injectable so the resolution order,
// parsing and verification are testable without the network.
//
// MODEL B NOTE: for OUR accounts the handle is the STABLE identifier and the
// did:key rotates beneath it, so the directory — not an external DNS zone — is
// the authority for our own handles. These adapters exist to resolve FOREIGN
// handles (importing outside identities and verifying their claims).

export class HandleResolutionError extends Schema.TaggedError<HandleResolutionError>()(
  'HandleResolutionError',
  {
    handle: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export class HandleVerificationError extends Schema.TaggedError<HandleVerificationError>()(
  'HandleVerificationError',
  {
    handle: Schema.String,
    did: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/**
 * The `did=…` value from a set of DNS TXT records. Records may be split into
 * chunks by the resolver, so callers should join chunks before calling.
 */
export const parseDidFromTxt = (records: readonly string[]) => {
  for (const record of records) {
    const match = /(?:^|[\s;])did=(did:[a-z0-9:._%-]+)/i.exec(record);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
};

/** A `/.well-known/atproto-did` body: a single DID, trimmed. */
export const parseDidFromWellKnown = (body: string) => {
  const value = body.trim();
  return value.startsWith('did:') ? value : undefined;
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface HandleTransportShape {
  /** TXT records for `_atproto.<handle>` (chunks already joined per record). */
  readonly lookupTxt: (
    handle: string,
  ) => Effect.Effect<readonly string[], HandleResolutionError>;
  /** Body of `https://<handle>/.well-known/atproto-did`, or undefined if absent. */
  readonly fetchWellKnown: (
    handle: string,
  ) => Effect.Effect<string | undefined, HandleResolutionError>;
}

export class HandleTransport extends Context.Service<
  HandleTransport,
  HandleTransportShape
>()('@eoa/identity/HandleTransport') {}

/**
 * DNS TXT over HTTPS, for runtimes that have no `node:dns` — a browser renderer,
 * say, where the import fails and every custom-domain handle publishes its
 * binding *only* as a TXT record (`accio.blue` does; its `/.well-known` is a 404).
 * Without this, such a handle reads as not found in any non-Node runtime.
 *
 * The values come back in DNS presentation form: each string quoted, and a
 * record split across chunks arrives as `"part1" "part2"`. Drop the quotes and
 * the whitespace between them so the chunks rejoin — the same shape
 * `node:dns`'s `resolveTxt` (joined per record) hands the parser.
 */
/** The resolver's answer: TXT records, presentation-form quoted. */
const DohResponse = Schema.Struct({
  Answer: Schema.optional(
    Schema.Array(Schema.Struct({ data: Schema.optional(Schema.String) })),
  ),
});

export const lookupTxtViaDoh = async (
  handle: string,
): Promise<readonly string[]> => {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`,
    { headers: { accept: 'application/dns-json' } },
  );
  if (!response.ok) {
    return [];
  }
  const decoded = Schema.decodeUnknownOption(DohResponse)(
    await response.json(),
  );
  if (Option.isNone(decoded)) {
    return [];
  }
  return (decoded.value.Answer ?? [])
    .map((answer) =>
      (answer.data ?? '').replace(/"\s*"/g, '').replace(/"/g, ''),
    )
    .filter((data) => data.length > 0);
};

/**
 * `resolveTxt` when the runtime has Node's DNS; `undefined` when it does not —
 * the import is the probe, so a failed dynamic import is data, not a failure.
 */
const nodeResolveTxt = (): Effect.Effect<
  ((hostname: string) => Promise<string[][]>) | undefined
> =>
  Effect.tryPromise({
    try: async () => (await import('node:dns/promises')).resolveTxt,
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Live transport: node DNS for TXT, global fetch for the well-known document. */
export const liveHandleTransport: HandleTransportShape = {
  lookupTxt: (handle) =>
    Effect.gen(function* () {
      const resolveTxt = yield* nodeResolveTxt();

      if (resolveTxt === undefined) {
        // No `node:dns`: a browser renderer. Ask a resolver over HTTPS instead,
        // or every custom-domain handle (TXT-only) reads as not found.
        return yield* Effect.tryPromise({
          try: () => lookupTxtViaDoh(handle),
          catch: (cause) =>
            new HandleResolutionError({
              handle,
              reason: 'dns',
              message: `DoH lookup for _atproto.${handle} failed: ${String(cause)}`,
            }),
        });
      }

      const records = yield* Effect.tryPromise({
        try: () => resolveTxt(`_atproto.${handle}`),
        catch: (cause) =>
          new HandleResolutionError({
            handle,
            reason: 'dns',
            message: `TXT lookup for _atproto.${handle} failed: ${String(cause)}`,
          }),
      });
      return records.map((chunks) => chunks.join(''));
    }),
  fetchWellKnown: (handle) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(
          `https://${handle}/.well-known/atproto-did`,
        );
        return response.ok ? await response.text() : undefined;
      },
      catch: (cause) =>
        new HandleResolutionError({
          handle,
          reason: 'well-known',
          message: `well-known fetch for ${handle} failed: ${String(cause)}`,
        }),
    }),
};

export const handleTransportLayer: Layer.Layer<HandleTransport> = Layer.succeed(
  HandleTransport,
  liveHandleTransport,
);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a handle to a DID: DNS TXT first, well-known as the fallback. A
 * transport failure at either step falls through to the next; only when both
 * come up empty is the handle considered not found.
 */
export const resolveHandleFromNetwork = (handle: string) =>
  Effect.gen(function* () {
    const transport = yield* HandleTransport;

    const fromTxt = yield* transport.lookupTxt(handle).pipe(
      Effect.map(parseDidFromTxt),
      Effect.orElseSucceed(() => undefined),
    );
    if (fromTxt !== undefined) {
      return fromTxt as DID;
    }

    const body = yield* transport
      .fetchWellKnown(handle)
      .pipe(Effect.orElseSucceed(() => undefined));
    const fromWellKnown =
      body === undefined ? undefined : parseDidFromWellKnown(body);
    if (fromWellKnown !== undefined) {
      return fromWellKnown as DID;
    }

    return yield* new HandleNotFoundError({ identifier: handle });
  }).pipe(
    Effect.withSpan('identity.resolveHandleFromNetwork', {
      attributes: { 'identity.handle': handle },
    }),
  );

/** A DID document claims a handle via `alsoKnownAs: ['at://<handle>']`. */
export const verifyHandleBinding = (params: {
  readonly handle: string;
  readonly did: DID;
  readonly alsoKnownAs: readonly string[];
}) =>
  params.alsoKnownAs.includes(`at://${params.handle}`)
    ? Effect.void
    : new HandleVerificationError({
        handle: params.handle,
        did: params.did,
        message: 'DID document does not claim this handle',
      });

/**
 * Resolve a handle AND verify the claim: the resolved DID document must list
 * `at://<handle>` in its `alsoKnownAs`, otherwise the binding is rejected.
 */
export const resolveVerifiedHandle = <E, R>(params: {
  readonly handle: string;
  readonly resolveDocument: (
    did: DID,
  ) => Effect.Effect<{ readonly alsoKnownAs: readonly string[] }, E, R>;
}) =>
  Effect.gen(function* () {
    const did = yield* resolveHandleFromNetwork(params.handle);
    const document = yield* params.resolveDocument(did);
    yield* verifyHandleBinding({
      handle: params.handle,
      did,
      alsoKnownAs: document.alsoKnownAs,
    });
    return did;
  }).pipe(
    Effect.withSpan('identity.resolveVerifiedHandle', {
      attributes: { 'identity.handle': params.handle },
    }),
  );
