import type {
  ETag,
  ListOptions,
  ObjectBody,
  ObjectKey,
  StoredObject,
  WriteConditionMap,
} from './types.js';
import { Effect, Layer, Match, Option } from 'effect';
import { ObjectStoreUnavailable, PreconditionFailed } from './types.js';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { ObjectStore } from './object-store.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** How many keys a listing returns when the caller does not say. */
const DEFAULT_LIMIT = 1000;

/** The body's digest: the etag changes exactly when the bytes do. */
const etagOf = (body: ObjectBody) =>
  createHash('sha256').update(body).digest('hex');

/** One flat filename per key, so a key is preserved byte for byte. */
const fileNameOf = (key: ObjectKey) =>
  `${Buffer.from(key, 'utf8').toString('hex')}.obj`;

const keyOf = (name: string) =>
  Buffer.from(name.slice(0, -'.obj'.length), 'hex').toString('utf8');

/** The etag on disk, or `undefined` when there is no object there. */
const currentEtag = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path).then((buffer) => etagOf(new Uint8Array(buffer))),
    // ponytail: the dev adapter reads any failure as absence; a bucket's
    // adapter distinguishes not-found from unavailable.
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Refuse a write unless the object is what the caller assumed. */
const require = (params: {
  readonly key: ObjectKey;
  readonly condition: WriteConditionMap | undefined;
  readonly current: ETag | undefined;
}) =>
  Match.value(params.condition).pipe(
    Match.tag('absent', () =>
      params.current === undefined
        ? Effect.void
        : Effect.fail(
            new PreconditionFailed({ key: params.key, expected: 'absent' }),
          ),
    ),
    Match.tag('holds', (held) =>
      params.current === held.etag
        ? Effect.void
        : Effect.fail(
            new PreconditionFailed({ key: params.key, expected: held.etag }),
          ),
    ),
    Match.orElse(() => Effect.void),
  );

/** Whether the write is a create-only one. */
const isAbsent = (condition: WriteConditionMap | undefined) =>
  Match.value(condition).pipe(
    Match.tag('absent', () => true),
    Match.orElse(() => false),
  );

/**
 * The filesystem adapter — the one that runs with no bucket and no container
 * runtime, so development exercises a real object store and not only memory
 * (the Effect-PDS map, `uasm`).
 */
export const filesystemObjectStoreLayer = (root: string) =>
  Layer.effect(
    ObjectStore,
    Effect.tryPromise({
      try: () => mkdir(root, { recursive: true }),
      catch: (cause) =>
        new ObjectStoreUnavailable({ key: root, message: String(cause) }),
    }).pipe(
      Effect.as(
        ObjectStore.of({
          get: (key) =>
            Effect.tryPromise({
              try: async () => {
                const body = new Uint8Array(
                  await readFile(join(root, fileNameOf(key))),
                );
                return Option.some<StoredObject>({
                  key,
                  body,
                  etag: etagOf(body),
                });
              },
              catch: () => Option.none<StoredObject>(),
            }).pipe(Effect.orElseSucceed(() => Option.none<StoredObject>())),

          put: (key, body, condition) =>
            Effect.gen(function* () {
              const path = join(root, fileNameOf(key));
              const current = yield* currentEtag(path);
              yield* require({ key, condition, current });
              const described = yield* Effect.tryPromise({
                try: async () => {
                  await writeFile(
                    path,
                    body,
                    isAbsent(condition) ? { flag: 'wx' } : {},
                  );
                  return Option.none<string>();
                },
                catch: (cause) => Option.some(String(cause)),
              }).pipe(Effect.catch((failure) => Effect.succeed(failure)));
              if (Option.isNone(described)) {
                return etagOf(body);
              }
              // An exclusive create that lost its race: the object is there now.
              if (
                isAbsent(condition) &&
                (yield* currentEtag(path)) !== undefined
              ) {
                return yield* Effect.fail(
                  new PreconditionFailed({ key, expected: 'absent' }),
                );
              }
              return yield* Effect.fail(
                new ObjectStoreUnavailable({ key, message: described.value }),
              );
            }),

          delete: (key, condition) =>
            Effect.gen(function* () {
              const path = join(root, fileNameOf(key));
              const current = yield* currentEtag(path);
              yield* require({ key, condition, current });
              yield* Effect.tryPromise({
                try: () => rm(path, { force: true }),
                catch: (cause) =>
                  new ObjectStoreUnavailable({ key, message: String(cause) }),
              });
            }),

          list: (options: ListOptions | undefined) =>
            Effect.tryPromise({
              try: async () => {
                const prefix = options?.prefix ?? '';
                const keys = (await readdir(root))
                  .filter((name) => name.endsWith('.obj'))
                  .map(keyOf)
                  .filter((key) => key.startsWith(prefix))
                  .sort();
                const after = options?.cursor;
                const remaining =
                  after === undefined
                    ? keys
                    : keys.filter((key) => key > after);
                const page = remaining.slice(
                  0,
                  options?.limit ?? DEFAULT_LIMIT,
                );
                const last = page.at(-1);
                const cursor =
                  remaining.length > page.length && last !== undefined
                    ? last
                    : undefined;
                return cursor === undefined
                  ? { keys: page }
                  : { keys: page, cursor };
              },
              catch: () => ({ keys: [] }),
            }).pipe(Effect.orElseSucceed(() => ({ keys: [] }))),
        }),
      ),
    ),
  );
