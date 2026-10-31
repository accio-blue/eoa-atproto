import { Effect, Layer, Match, Option } from 'effect';
import {
  type ListOptions,
  ObjectStoreUnavailable,
  PreconditionFailed,
  type WriteConditionMap,
} from './types.js';
import { ObjectStore } from './object-store.js';

/**
 * The slice of a Worker's R2 binding this adapter calls. Structural, so the package needs neither
 * `@cloudflare/workers-types` nor a runtime: the binding a Worker is handed satisfies it as it is.
 */
export interface R2BucketLike {
  readonly get: (key: string) => Promise<{
    readonly etag: string;
    readonly arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;
  readonly put: (
    key: string,
    value: Uint8Array,
    options?: {
      readonly onlyIf?: {
        readonly etagMatches?: string;
        readonly etagDoesNotMatch?: string;
      };
    },
  ) => Promise<{ readonly etag: string } | null>;
  readonly delete: (key: string) => Promise<void>;
  readonly list: (options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }) => Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

const failed = (key: string) => (cause: unknown) =>
  new ObjectStoreUnavailable({ key, message: String(cause) });

/**
 * The condition as an `R2Conditional`: a plain object, which every caller of the binding can pass
 * (a `Headers` does not cross Miniflare's proxy). `etagDoesNotMatch: '*'` is "only if absent".
 */
const onlyIf = (condition: WriteConditionMap | undefined) =>
  condition === undefined
    ? undefined
    : Match.value(condition).pipe(
        Match.tag('absent', () => ({ etagDoesNotMatch: '*' })),
        Match.tag('holds', ({ etag }) => ({ etagMatches: etag })),
        Match.exhaustive,
      );

const expectedOf = (condition: WriteConditionMap | undefined) =>
  condition?._tag === 'holds' ? condition.etag : 'absent';

/**
 * The object store on a Worker's R2 binding: the bucket the vlpds engine (`@eoa/kv`'s LSM) keeps
 * its log and runs in, without SigV4 or a second hop through the S3 API.
 *
 * A conditional `put` is R2's own (`onlyIf`, answered `null` when it does not hold), so the LSM's
 * claim-a-sequence and the lease's fencing are atomic here. R2 has no conditional `delete`; one is
 * refused rather than emulated by a read and a delete, which is a race and not a condition. Nothing
 * in the engine asks for one.
 */
export const r2ObjectStoreLayer = (bucket: R2BucketLike) =>
  Layer.succeed(ObjectStore, {
    get: (key) =>
      Effect.tryPromise({
        try: async () => {
          const found = await bucket.get(key);
          return found === null
            ? Option.none()
            : Option.some({
                key,
                body: new Uint8Array(await found.arrayBuffer()),
                etag: found.etag,
              });
        },
        catch: failed(key),
      }),

    put: (key, body, condition) =>
      Effect.tryPromise({
        try: () => {
          const conditional = onlyIf(condition);
          return bucket.put(
            key,
            body,
            conditional === undefined ? {} : { onlyIf: conditional },
          );
        },
        catch: failed(key),
      }).pipe(
        Effect.flatMap((stored) =>
          stored === null
            ? Effect.fail(
                new PreconditionFailed({
                  key,
                  expected: expectedOf(condition),
                }),
              )
            : Effect.succeed(stored.etag),
        ),
      ),

    delete: (key, condition) =>
      condition === undefined
        ? Effect.tryPromise({
            try: () => bucket.delete(key),
            catch: failed(key),
          })
        : Effect.fail(
            new ObjectStoreUnavailable({
              key,
              message: 'the R2 binding has no conditional delete',
            }),
          ),

    list: (options: ListOptions | undefined) =>
      Effect.tryPromise({
        try: () =>
          bucket.list({
            ...(options?.prefix === undefined
              ? {}
              : { prefix: options.prefix }),
            ...(options?.limit === undefined ? {} : { limit: options.limit }),
            ...(options?.cursor === undefined
              ? {}
              : { cursor: options.cursor }),
          }),
        catch: failed(options?.prefix ?? ''),
      }).pipe(
        Effect.map((listed) => {
          const keys = listed.objects.map((one) => one.key);
          // R2's cursor is opaque, and only meaningful while the listing is truncated.
          return listed.truncated && listed.cursor !== undefined
            ? { keys, cursor: listed.cursor }
            : { keys };
        }),
      ),
  });
