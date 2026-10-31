import { Effect, Layer, Match, Option } from 'effect';
import type {
  ListOptions,
  ObjectBody,
  StoredObject,
  WriteConditionMap,
} from './types.js';
import { ObjectStoreUnavailable, PreconditionFailed } from './types.js';
import { sha256Hex, sign, uriEncode } from './sigv4.js';
import { ObjectStore } from './object-store.js';

/** The empty body's digest; S3 wants the payload hash on every request. */
const EMPTY = sha256Hex('');

export interface S3Options {
  /** The S3-compatible endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const trimmed = (endpoint: string) => endpoint.replace(/\/+$/, '');

const encodePath = (key: string) => key.split('/').map(uriEncode).join('/');

const objectUrl = (config: S3Options, key: string) =>
  `${trimmed(config.endpoint)}/${uriEncode(config.bucket)}/${encodePath(key)}`;

const bucketUrl = (config: S3Options) =>
  `${trimmed(config.endpoint)}/${uriEncode(config.bucket)}`;

const unavailable = (key: string, status: number) =>
  new ObjectStoreUnavailable({ key, message: `the bucket answered ${status}` });

/** The condition, as the headers S3 states it in. */
const conditionHeaders = (condition: WriteConditionMap | undefined) =>
  Match.value(condition).pipe(
    Match.tag('absent', () => ({ 'if-none-match': '*' })),
    Match.tag('holds', (held) => ({ 'if-match': held.etag })),
    Match.orElse(() => ({})),
  );

const expectedOf = (condition: WriteConditionMap | undefined) =>
  Match.value(condition).pipe(
    Match.tag('absent', () => 'absent'),
    Match.tag('holds', (held) => held.etag),
    Match.orElse(() => ''),
  );

const call = (params: {
  readonly config: S3Options;
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ObjectBody;
}) =>
  Effect.tryPromise({
    try: async () => {
      const payloadHash =
        params.body === undefined ? EMPTY : sha256Hex(params.body);
      const signed = sign({
        method: params.method,
        url: params.url,
        headers: params.headers ?? {},
        payloadHash,
        region: params.config.region,
        service: 's3',
        accessKeyId: params.config.accessKeyId,
        secretAccessKey: params.config.secretAccessKey,
        at: new Date(),
      });
      return await fetch(params.url, {
        method: params.method,
        headers: { ...signed.headers, authorization: signed.authorization },
        ...(params.body === undefined
          ? {}
          : { body: new Uint8Array(params.body) }),
      });
    },
    catch: (cause) =>
      new ObjectStoreUnavailable({ key: params.url, message: String(cause) }),
  });

const listQuery = (options: ListOptions | undefined) => {
  const pairs: Array<readonly [string, string]> = [['list-type', '2']];
  if (options?.prefix !== undefined) {
    pairs.push(['prefix', options.prefix]);
  }
  if (options?.limit !== undefined) {
    pairs.push(['max-keys', String(options.limit)]);
  }
  if (options?.cursor !== undefined) {
    pairs.push(['continuation-token', options.cursor]);
  }
  return pairs
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .join('&');
};

const XML_ENTITIES = new Map<string, string>([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
]);

const unescapeXml = (value: string) =>
  value.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) => XML_ENTITIES.get(entity) ?? entity,
  );

const tagOf = (xml: string, name: string) => {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return found === null ? undefined : found[1];
};

/** ListObjectsV2's answer: the keys, and the token if more follow. */
const parseListing = (xml: string) => {
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
    unescapeXml(match[1] ?? ''),
  );
  const token =
    tagOf(xml, 'IsTruncated') === 'true'
      ? tagOf(xml, 'NextContinuationToken')
      : undefined;
  return token === undefined ? { keys } : { keys, cursor: unescapeXml(token) };
};

/**
 * The S3 (and R2) adapter. The two speak the same signature and the same
 * conditional headers, so one adapter is both, and the difference is a config.
 */
export const s3ObjectStoreLayer = (config: S3Options) =>
  Layer.succeed(
    ObjectStore,
    ObjectStore.of({
      get: (key) =>
        Effect.gen(function* () {
          const response = yield* call({
            config,
            method: 'GET',
            url: objectUrl(config, key),
          });
          if (response.status === 404) {
            return Option.none<StoredObject>();
          }
          if (!response.ok) {
            return yield* Effect.fail(unavailable(key, response.status));
          }
          return yield* Effect.tryPromise({
            try: async () =>
              Option.some<StoredObject>({
                key,
                body: new Uint8Array(await response.arrayBuffer()),
                etag: response.headers.get('etag') ?? '',
              }),
            catch: (cause) =>
              new ObjectStoreUnavailable({ key, message: String(cause) }),
          });
        }),

      put: (key, body, condition) =>
        Effect.gen(function* () {
          const response = yield* call({
            config,
            method: 'PUT',
            url: objectUrl(config, key),
            headers: conditionHeaders(condition),
            body,
          });
          if (response.status === 412) {
            return yield* Effect.fail(
              new PreconditionFailed({ key, expected: expectedOf(condition) }),
            );
          }
          if (!response.ok) {
            return yield* Effect.fail(unavailable(key, response.status));
          }
          return response.headers.get('etag') ?? '';
        }),

      delete: (key, condition) =>
        Effect.gen(function* () {
          const response = yield* call({
            config,
            method: 'DELETE',
            url: objectUrl(config, key),
            headers: conditionHeaders(condition),
          });
          if (response.status === 412) {
            return yield* Effect.fail(
              new PreconditionFailed({ key, expected: expectedOf(condition) }),
            );
          }
          if (!response.ok && response.status !== 404) {
            return yield* Effect.fail(unavailable(key, response.status));
          }
        }),

      list: (options: ListOptions | undefined) =>
        Effect.gen(function* () {
          const response = yield* call({
            config,
            method: 'GET',
            url: `${bucketUrl(config)}?${listQuery(options)}`,
          });
          if (!response.ok) {
            return yield* Effect.fail(
              unavailable(config.bucket, response.status),
            );
          }
          return yield* Effect.tryPromise({
            try: async () => parseListing(await response.text()),
            catch: (cause) =>
              new ObjectStoreUnavailable({
                key: config.bucket,
                message: String(cause),
              }),
          });
        }),
    }),
  );
