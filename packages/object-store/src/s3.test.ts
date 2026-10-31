import { Effect, Option } from 'effect';
import { type IncomingMessage, createServer } from 'node:http';
import { type S3Options, s3ObjectStoreLayer } from './s3.js';
import { expect, it } from 'vitest';
import { ifAbsent, ifHolds } from './types.js';
import { ObjectStore } from './object-store.js';
import { randomUUID } from 'node:crypto';

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const bodyOf = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface FakeObject {
  readonly body: Buffer;
  readonly etag: string;
}

/** Just enough S3: the four verbs, the conditional headers, and ListObjectsV2. */
const startFakeBucket = async () => {
  const objects = new Map<string, FakeObject>();

  const answer = async (
    request: IncomingMessage,
    respond: (
      status: number,
      headers?: Record<string, string>,
      body?: string | Buffer,
    ) => void,
  ) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\//, '');
    const cut = path.indexOf('/');
    const key = cut < 0 ? '' : decodeURIComponent(path.slice(cut + 1));

    if (request.method === 'GET' && key === '') {
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

    if (request.method === 'GET') {
      if (found === undefined) {
        respond(404);
        return;
      }
      respond(200, { etag: found.etag }, found.body);
      return;
    }

    if (request.method === 'PUT') {
      const body = await bodyOf(request);
      const ifNoneMatch = request.headers['if-none-match'];
      const ifMatch = request.headers['if-match'];
      if (ifNoneMatch === '*' && found !== undefined) {
        respond(412);
        return;
      }
      if (typeof ifMatch === 'string' && found?.etag !== ifMatch) {
        respond(412);
        return;
      }
      const etag = `"${randomUUID()}"`;
      objects.set(key, { body, etag });
      respond(200, { etag });
      return;
    }

    if (request.method === 'DELETE') {
      const ifMatch = request.headers['if-match'];
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
    void answer(request, (status, headers, body) => {
      response.writeHead(status, headers ?? {});
      response.end(body);
    });
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

const config = (endpoint: string) => ({
  endpoint,
  bucket: 'test',
  region: 'us-east-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
});

const withBucket = async <A>(body: (options: S3Options) => Promise<A>) => {
  const bucket = await startFakeBucket();
  try {
    return await body(config(bucket.url));
  } finally {
    await bucket.close();
  }
};

const run = <A, E>(
  options: S3Options,
  effect: Effect.Effect<A, E, ObjectStore>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.orDie, Effect.provide(s3ObjectStoreLayer(options))),
  );

it('round-trips a body and its etag', () =>
  withBucket(async (options) => {
    const result = await run(
      options,
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        const etag = yield* store.put('a/b', bytes('hello'));
        const found = yield* store.get('a/b');
        const missing = yield* store.get('nope');
        return { etag, found, missing };
      }),
    );

    expect(result.etag).not.toBe('');
    expect(Option.isSome(result.found)).toBe(true);
    expect(
      Option.isSome(result.found) ? text(result.found.value.body) : undefined,
    ).toBe('hello');
    expect(
      Option.isSome(result.found) ? result.found.value.etag : undefined,
    ).toBe(result.etag);
    expect(Option.isNone(result.missing)).toBe(true);
  }));

it('refuses a create when the key is already there', () =>
  withBucket(async (options) => {
    const result = await run(
      options,
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        yield* store.put('a', bytes('one'));
        const failure = yield* Effect.flip(
          store.put('a', bytes('two'), ifAbsent()),
        );
        const kept = yield* store.get('a');
        return { failure, kept };
      }),
    );

    expect(result.failure._tag).toBe('PreconditionFailed');
    expect(
      Option.isSome(result.kept) ? text(result.kept.value.body) : undefined,
    ).toBe('one');
  }));

it('refuses a stale etag and takes the current one', () =>
  withBucket(async (options) => {
    const result = await run(
      options,
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        const first = yield* store.put('a', bytes('one'));
        const stale = yield* Effect.flip(
          store.put('a', bytes('two'), ifHolds({ etag: '"stale"' })),
        );
        const fresh = yield* store.put(
          'a',
          bytes('two'),
          ifHolds({ etag: first }),
        );
        const read = yield* store.get('a');
        return { stale, fresh, read };
      }),
    );

    expect(result.stale._tag).toBe('PreconditionFailed');
    expect(result.fresh).not.toBe(result.stale._tag);
    expect(
      Option.isSome(result.read) ? text(result.read.value.body) : undefined,
    ).toBe('two');
  }));

it('deletes an object so it reads absent afterwards', () =>
  withBucket(async (options) => {
    const result = await run(
      options,
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        yield* store.put('a', bytes('one'));
        yield* store.delete('a');
        return yield* store.get('a');
      }),
    );

    expect(Option.isNone(result)).toBe(true);
  }));

it('lists by prefix and pages with a cursor', () =>
  withBucket(async (options) => {
    const result = await run(
      options,
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        yield* store.put('k/a', bytes('a'));
        yield* store.put('k/b', bytes('b'));
        yield* store.put('k/c', bytes('c'));
        yield* store.put('z/one', bytes('z'));
        const first = yield* store.list({ prefix: 'k/', limit: 2 });
        const cursor = first.cursor;
        const second =
          cursor === undefined
            ? undefined
            : yield* store.list({ prefix: 'k/', limit: 2, cursor });
        return { first: first.keys, cursor, second: second?.keys };
      }),
    );

    expect(result.first).toEqual(['k/a', 'k/b']);
    expect(result.cursor).toBeDefined();
    expect(result.second).toEqual(['k/c']);
  }));

it('reports a bucket that will not answer', () =>
  withBucket(async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ObjectStore;
        return yield* store.get('a');
      }).pipe(
        Effect.provide(s3ObjectStoreLayer(config('http://127.0.0.1:1'))),
        Effect.flip,
      ),
    );

    expect(failure._tag).toBe('ObjectStoreUnavailable');
  }));
