import { Effect, Layer, Option } from 'effect';
import {
  ObjectStore,
  type S3Options,
  s3ObjectStoreLayer,
} from '@eoa/object-store';
import { describe, expect, it } from 'vitest';
import { Kv } from './kv.js';
import { createServer } from 'node:http';
import { kvLsmLayer } from './lsm.js';
import { randomUUID } from 'node:crypto';
import { shardLeaseLayer } from './lease.js';

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const read = (found: Option.Option<{ readonly value: Uint8Array }>) =>
  Option.isSome(found) ? text(found.value.value) : undefined;

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface FakeObject {
  readonly body: Buffer;
  readonly etag: string;
}

/**
 * Just enough S3 for the LSM: the four verbs, the conditional headers, and
 * ListObjectsV2 with a continuation token — the semantics the store's
 * correctness rests on. The s3 adapter's own test builds the same fixture; this
 * one is here because the *combination* — the LSM driving S3 — is what a
 * deployment runs and neither package's test covers alone.
 *
 * ponytail: the fixture is copied from `@eoa/object-store`'s test rather than
 * exported, because that package's public surface should not grow a fake. If a
 * third consumer appears, lift it into a shared test module.
 */
const startFakeBucket = async () => {
  const objects = new Map<string, FakeObject>();

  const bodyOf = (request: NodeJS.ReadableStream) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const answer = async (
    method: string,
    url: URL,
    headers: NodeJS.Dict<string | string[]>,
    body: () => Promise<Buffer>,
    respond: (
      status: number,
      headers?: Record<string, string>,
      payload?: string | Buffer,
    ) => void,
  ) => {
    const path = url.pathname.replace(/^\//, '');
    const cut = path.indexOf('/');
    const key = cut < 0 ? '' : decodeURIComponent(path.slice(cut + 1));

    if (method === 'GET' && key === '') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const max = Number(url.searchParams.get('max-keys') ?? '1000');
      const after = url.searchParams.get('continuation-token');
      const keys = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort();
      const start = after === null ? 0 : keys.indexOf(after) + 1;
      const page = keys.slice(start, start + max);
      const more = start + max < keys.length;
      const next = more ? page[page.length - 1] : undefined;
      respond(
        200,
        { 'content-type': 'application/xml' },
        [
          '<?xml version="1.0"?>',
          '<ListBucketResult>',
          page
            .map((name) => `<Contents><Key>${escapeXml(name)}</Key></Contents>`)
            .join(''),
          `<IsTruncated>${more ? 'true' : 'false'}</IsTruncated>`,
          next === undefined
            ? ''
            : `<NextContinuationToken>${escapeXml(next)}</NextContinuationToken>`,
          '</ListBucketResult>',
        ].join(''),
      );
      return;
    }

    const found = objects.get(key);
    if (method === 'GET') {
      if (found === undefined) {
        respond(404);
        return;
      }
      respond(200, { etag: found.etag }, found.body);
      return;
    }
    if (method === 'PUT') {
      const payload = await body();
      const ifNoneMatch = headers['if-none-match'];
      const ifMatch = headers['if-match'];
      if (ifNoneMatch === '*' && found !== undefined) {
        respond(412);
        return;
      }
      if (typeof ifMatch === 'string' && found?.etag !== ifMatch) {
        respond(412);
        return;
      }
      const etag = `"${randomUUID()}"`;
      objects.set(key, { body: payload, etag });
      respond(200, { etag });
      return;
    }
    if (method === 'DELETE') {
      const ifMatch = headers['if-match'];
      if (typeof ifMatch === 'string' && found?.etag !== ifMatch) {
        respond(412);
        return;
      }
      objects.delete(key);
      respond(204);
      return;
    }
    respond(400);
  };

  const server = createServer((request, response) => {
    void answer(
      request.method ?? 'GET',
      new URL(request.url ?? '/', 'http://fake'),
      request.headers,
      () => bodyOf(request),
      (status, headers, payload) => {
        response.writeHead(status, headers ?? {});
        response.end(payload);
      },
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

const bucketOptions = (endpoint: string): S3Options => ({
  endpoint,
  bucket: 'test',
  region: 'us-east-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
});

/** The LSM over an S3-backed store, leased — the shape a deployment runs. */
const layers = (options: S3Options) => {
  const store = s3ObjectStoreLayer(options);
  return kvLsmLayer({
    threshold: 16,
    lease: { shard: 'single', owner: 'test' },
  }).pipe(Layer.provide([shardLeaseLayer.pipe(Layer.provide(store)), store]));
};

/** The bucket's listing, read back through the store that wrote it. */
const keysIn = (options: S3Options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const objects = yield* ObjectStore;
      return (yield* objects.list()).keys;
    }).pipe(Effect.orDie, Effect.provide(s3ObjectStoreLayer(options))),
  );

describe('the KV seam, over an S3 bucket', () => {
  it('round-trips through the LSM, and the objects rest in the bucket', async () => {
    const bucket = await startFakeBucket();
    try {
      const options = bucketOptions(bucket.url);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          yield* kv.put('b', bytes('two'));
          const a = yield* kv.get('a');
          const b = yield* kv.get('b');
          return { a: read(a), b: read(b), sequence: yield* kv.sequence };
        }).pipe(Effect.orDie, Effect.provide(layers(options))),
      );

      expect(result).toEqual({ a: 'one', b: 'two', sequence: 2 });

      // The lease was taken by conditional PUT, and the writes are objects
      // named by their sequence — so they can be listed from the bucket, which
      // is what "the KV runs on the bucket" means.
      const keys = await keysIn(options);
      expect(keys).toContain('leases/single');
      expect(keys.some((key) => key.startsWith('log/'))).toBe(true);
    } finally {
      await bucket.close();
    }
  });
});
