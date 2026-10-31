import { Context, Effect, Layer, Ref } from 'effect';
import type { Json } from 'effect/Schema';

/**
 * The AppView's canonical record store: what the read endpoints serve from.
 *
 * Records arrive from our own firehose and history from the PDSes, each already
 * a `{ uri, cid, value }` envelope. The store is keyed by URI, so a create and
 * an update are the same write - the newer envelope simply replaces the older -
 * and a delete removes by URI.
 *
 * `list` filters on the collection segment of `at://<did>/<collection>/<rkey>`
 * (and on the repo, when one is given) and orders by `rkey`; its cursor is the
 * last `rkey` returned, the same convention the PDS uses in
 * `listRecordsOperation`, so a consumer pages the two the same way.
 *
 * The ingest sequence is deliberately absent: the order records apply in is the
 * ingestion pipeline's rule (`ingestion-pipeline.ts`), not this store's. This
 * store only holds what is canonical now.
 *
 * Durability is not modelled, like every store in this repo: the records live
 * in a `Ref`-held `Map` and are rebuilt per `Effect.provide`. Swapping the
 * `Ref` for a durable backend is a separate concern from this shape.
 */

/** A record as the wire carries it: JSON, and nothing else. */
export type CanonicalRecord = {
  readonly uri: string;
  readonly cid: string;
  readonly value: Json;
};

export interface CanonicalStoreShape {
  /** Apply a record: a create and an update are the same write. */
  readonly apply: (record: CanonicalRecord) => Effect.Effect<void>;
  /** Delete by URI: true when one was there. */
  readonly remove: (uri: string) => Effect.Effect<boolean>;
  readonly get: (uri: string) => Effect.Effect<CanonicalRecord | undefined>;
  /** One collection's records, optionally of one repo (DID), in `rkey` order, after `cursor`, up to `limit`. */
  readonly list: (params: {
    readonly collection: string;
    readonly repo?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<{
    readonly records: readonly CanonicalRecord[];
    readonly cursor?: string | undefined;
  }>;
  readonly size: Effect.Effect<number>;
}

export class CanonicalStore extends Context.Service<
  CanonicalStore,
  CanonicalStoreShape
>()('@eoa/appview/CanonicalStore') {}

/** The page size a request gets when it does not ask for one. */
const DEFAULT_LIST_LIMIT = 50;

const AT_URI_PREFIX = 'at://';

/**
 * The repo (DID), collection and `rkey` out of `at://<did>/<collection>/<rkey>`,
 * or `undefined` when the URI is not shaped like one. Splitting on the first two
 * slashes keeps a DID with a colon in its method (`did:web:example.com`) intact.
 */
const recordKeyOf = (uri: string) => {
  if (!uri.startsWith(AT_URI_PREFIX)) {
    return undefined;
  }

  const withoutScheme = uri.slice(AT_URI_PREFIX.length);
  const didEnd = withoutScheme.indexOf('/');
  if (didEnd < 0) {
    return undefined;
  }

  const afterDid = withoutScheme.slice(didEnd + 1);
  const collectionEnd = afterDid.indexOf('/');
  if (collectionEnd < 0) {
    return undefined;
  }

  return {
    repo: withoutScheme.slice(0, didEnd),
    collection: afterDid.slice(0, collectionEnd),
    rkey: afterDid.slice(collectionEnd + 1),
  };
};

export const canonicalStoreLayer: Layer.Layer<CanonicalStore> = Layer.effect(
  CanonicalStore,
  Effect.gen(function* () {
    const records = yield* Ref.make<ReadonlyMap<string, CanonicalRecord>>(
      new Map(),
    );

    return {
      apply: (record) =>
        Ref.update(records, (current) =>
          new Map(current).set(record.uri, record),
        ),

      remove: (uri) =>
        Ref.modify(records, (current) => {
          if (!current.has(uri)) {
            // Nothing to remove: return the map untouched so `size` is
            // unaffected rather than copied.
            return [false, current];
          }

          const remaining = new Map(current);
          remaining.delete(uri);
          return [true, remaining];
        }),

      get: (uri) => Effect.map(Ref.get(records), (current) => current.get(uri)),

      list: ({ collection, repo, cursor, limit }) =>
        Effect.map(Ref.get(records), (current) => {
          const page = [...current.values()]
            .flatMap((record) => {
              const key = recordKeyOf(record.uri);
              return key === undefined ||
                key.collection !== collection ||
                (repo !== undefined && key.repo !== repo)
                ? []
                : [{ rkey: key.rkey, record }];
            })
            // The cursor is exclusive: it was the last rkey of the previous
            // page, so the next page starts strictly after it.
            .filter((entry) => cursor === undefined || entry.rkey > cursor)
            .sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0))
            .slice(0, limit ?? DEFAULT_LIST_LIMIT);

          const last = page[page.length - 1];
          return {
            records: page.map((entry) => entry.record),
            // The next cursor is the last rkey returned, as the PDS does.
            ...(last === undefined ? {} : { cursor: last.rkey }),
          };
        }),

      size: Effect.map(Ref.get(records), (current) => current.size),
    } satisfies CanonicalStoreShape;
  }),
);
