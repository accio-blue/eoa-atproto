import { type CborValue, CidLink, decodeCbor, formatCid } from '@eoa/core';
import { Effect, Match, Option, Schema } from 'effect';
import {
  type PdsConfig,
  authenticateAccess,
  forbidden,
  invalid,
  notFound,
  readableDid,
  serverError,
} from './pds.js';
import { XrpcError, type XrpcServer } from '@eoa/xrpc-server';
import { type AccountStore } from './account-store.js';
import { type BlobStore } from './blob-store.js';
import type { DpopReplay } from './dpop-replay.js';
import { RepoStore } from '@eoa/repo-store';

/**
 * Blobs at the surface (the Effect-PDS map, `m4jw`).
 *
 * Three methods, and the shape of them is the point: `uploadBlob` takes a body
 * that is *bytes* and answers with the reference a record holds;
 * `sync.getBlob` answers with those bytes and their type; `sync.listBlobs` says
 * which references a repo owns.
 *
 * The reference is `{$type: 'blob', ref: {$link: cid}, mimeType, size}` — the
 * exact object atproto puts inside a record, so what a client gets here is what
 * it stores there, and the link is the blob's identity rather than a location.
 */

/** The most a blob may be unless the operator says otherwise: 5 MiB. */
const BLOB_LIMIT_DEFAULT = 5 * 1024 * 1024;

const GetBlobSchema = Schema.Struct({
  did: Schema.String,
  cid: Schema.String,
});

const ListBlobsSchema = Schema.Struct({ did: Schema.String });

/** What the blob surface needs: the store, the accounts, and who we are. */
export interface BlobSurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly blobs: BlobStore['Service'];
  readonly repo: RepoStore['Service'];
  readonly replay: DpopReplay['Service'];
}

/**
 * Every blob a record names, by its CID.
 *
 * A blob reference is a map with `$type: 'blob'` and a `ref` that is a link, so
 * the walk looks for exactly that shape rather than for every link it meets: an
 * internal link (`com.atproto.repo.strongRef`) is not a blob, and counting one
 * would report a blob missing that was never meant to be there.
 */
export const blobCidsIn = (value: CborValue): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    return value.flatMap(blobCidsIn);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof CidLink ||
    value instanceof Uint8Array
  ) {
    return [];
  }
  const entries = Object.entries(value);
  const at = (name: string) => entries.find(([key]) => key === name)?.[1];
  if (at('$type') === 'blob') {
    const ref = at('ref');
    return ref instanceof CidLink ? [formatCid(ref.cid)] : [];
  }
  return entries.flatMap(([, one]) => blobCidsIn(one));
};

const limitOf = (config: PdsConfig) =>
  config.blobLimitBytes ?? BLOB_LIMIT_DEFAULT;

/** A content type without its parameters, or none when it says nothing. */
const typeOf = (header: string | undefined) => {
  const value = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return value === '' ? undefined : value;
};

/**
 * An allow-list entry is a whole type (`image/png`) or a family (`image/`), and
 * no list at all means any type — which is what atproto does, and what an
 * operator can narrow.
 */
const typeAllowed = (
  mimeType: string,
  allowed: readonly string[] | undefined,
) =>
  allowed === undefined ||
  allowed.some((entry) =>
    entry.endsWith('/') ? mimeType.startsWith(entry) : mimeType === entry,
  );

export const registerBlobMethods = (
  server: XrpcServer,
  deps: BlobSurfaceDeps,
) => {
  server.method('com.atproto.repo.uploadBlob', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const body = ctx.body;
      if (body === undefined || body.length === 0) {
        return yield* Effect.fail(invalid('a blob needs at least one byte'));
      }
      const mimeType = typeOf(ctx.headers['content-type']);
      if (mimeType === undefined) {
        return yield* Effect.fail(invalid('a blob needs a content type'));
      }
      if (!typeAllowed(mimeType, deps.config.allowedBlobTypes)) {
        return yield* Effect.fail(
          new XrpcError({
            error: 'BlobTypeNotAllowed',
            message: `${mimeType} is not a type this PDS takes`,
            status: 400,
          }),
        );
      }
      const outcome = yield* deps.blobs
        .upload({
          did: caller.account.did,
          bytes: body,
          mimeType,
          limit: limitOf(deps.config),
          now: Date.now(),
        })
        .pipe(
          Effect.mapError(() => serverError('the blob could not be stored')),
        );
      const stored = yield* Match.value(outcome).pipe(
        Match.tag('stored', (one) => Effect.succeed(one.blob)),
        Match.tag('tooLarge', (one) =>
          Effect.fail(
            new XrpcError({
              error: 'BlobTooLarge',
              message: `a blob here is at most ${one.limit} bytes`,
              status: 400,
            }),
          ),
        ),
        Match.tag('empty', () =>
          Effect.fail(invalid('a blob needs at least one byte')),
        ),
        Match.exhaustive,
      );
      return {
        blob: {
          $type: 'blob',
          ref: { $link: stored.cid },
          mimeType: stored.mimeType,
          size: stored.size,
        },
      };
    }),
  );

  // Public, like the repo: a blob is content-addressed, so holding the
  // reference is holding the address.
  server.method('com.atproto.sync.getBlob', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(GetBlobSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for getBlob'));
      }
      // A blob is public because it is content-addressed, but an account that
      // was taken down is not served at all — so its blobs stop being either.
      const { cid } = decoded.value;
      const did = yield* readableDid(deps, decoded.value.did);
      const found = yield* deps.blobs
        .blob(did, cid)
        .pipe(Effect.mapError(() => serverError('the blob could not be read')));
      const content = yield* deps.blobs
        .content(did, cid)
        .pipe(Effect.mapError(() => serverError('the blob could not be read')));
      if (Option.isNone(found) || Option.isNone(content)) {
        return yield* Effect.fail(
          notFound('BlobNotFound', `no blob ${cid} for ${did}`),
        );
      }
      return new Response(Uint8Array.from(content.value), {
        status: 200,
        headers: {
          'Content-Type': found.value.mimeType,
          'Content-Length': String(found.value.size),
        },
      });
    }),
  );

  server.method('com.atproto.sync.listBlobs', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const decoded = Schema.decodeUnknownOption(ListBlobsSchema)(ctx.params);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for listBlobs'));
      }
      const asked = decoded.value.did;
      if (asked !== caller.account.did && asked !== caller.account.handle) {
        return yield* Effect.fail(
          forbidden(`the blobs of ${asked} are not yours`),
        );
      }
      const blobs = yield* deps.blobs
        .list(caller.account.did)
        .pipe(
          Effect.mapError(() => serverError('the blobs could not be read')),
        );
      return { cids: blobs.map((one) => one.cid) };
    }),
  );

  // `repo.listMissingBlobs` is what a migration asks after a repo has arrived:
  // which of the blobs the records name did *not*. It is the media half of
  // `checkAccountStatus` — that one counts records, this one counts media.
  server.method('com.atproto.repo.listMissingBlobs', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticateAccess(deps, ctx);
      const did = caller.account.did;
      const leaves = yield* deps.repo
        .leaves(did, '', '\uffff')
        .pipe(Effect.mapError(() => serverError('the repo could not be read')));
      const stored = new Set(
        (yield* deps.blobs
          .list(did)
          .pipe(
            Effect.mapError(() => serverError('the blobs could not be read')),
          )).map((one) => one.cid),
      );
      const missing: Array<{ cid: string; recordUri: string }> = [];
      for (const leaf of leaves) {
        const record = yield* Effect.try({
          try: () => decodeCbor(leaf.value),
          catch: () => serverError('a record could not be read'),
        });
        for (const cid of blobCidsIn(record)) {
          if (!stored.has(cid)) {
            missing.push({ cid, recordUri: `at://${did}/${leaf.key}` });
          }
        }
      }
      return { blobs: missing };
    }),
  );
};
