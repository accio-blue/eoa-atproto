import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { startMemoryPds } from './memory.js';

const post = async (url: string, body: unknown, token?: string) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, string>,
  };
};

describe('startMemoryPds', () => {
  it('serves accounts and writes over HTTP, and Jetstream when asked', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds({ jetstream: true });
          const account = yield* Effect.promise(() =>
            post(`${pds.url}/xrpc/com.atproto.server.createAccount`, {
              handle: 'alice.pds.test',
              password: 'correct horse battery staple',
            }),
          );
          expect(account.status).toBe(200);

          const controller = new AbortController();
          const stream = yield* Effect.promise(() =>
            fetch(`${pds.url}/jetstream/subscribe`, {
              signal: controller.signal,
            }),
          );
          expect(stream.headers.get('content-type')).toContain(
            'application/x-ndjson',
          );

          const written = yield* Effect.promise(() =>
            post(
              `${pds.url}/xrpc/com.atproto.repo.createRecord`,
              {
                repo: account.body['did'],
                collection: 'app.example.note',
                record: { $type: 'app.example.note', text: 'hello' },
              },
              account.body['accessJwt'],
            ),
          );
          expect(written.status).toBe(200);

          const reader = stream.body?.getReader();
          const chunk = yield* Effect.promise(async () => reader?.read());
          const frame = JSON.parse(
            new TextDecoder().decode(chunk?.value).split('\n')[0] ?? '',
          );
          controller.abort();
          expect(frame.commit).toMatchObject({
            operation: 'create',
            collection: 'app.example.note',
            record: { text: 'hello' },
          });
        }),
      ),
    );
  });

  it('gives every keyless create in one applyWrites a key of its own, and answers each', async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const account = yield* Effect.promise(() =>
            post(`${pds.url}/xrpc/com.atproto.server.createAccount`, {
              handle: 'alice.pds.test',
              password: 'correct horse battery staple',
            }),
          );
          const did = account.body['did'] ?? '';
          const create = (text: string) => ({
            $type: 'com.atproto.repo.applyWrites#create',
            collection: 'app.example.note',
            value: { $type: 'app.example.note', text },
          });
          const applied = yield* Effect.promise(() =>
            fetch(`${pds.url}/xrpc/com.atproto.repo.applyWrites`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${account.body['accessJwt']}`,
              },
              body: JSON.stringify({
                repo: did,
                writes: [create('one'), create('two')],
              }),
            }).then((response) => response.json()),
          );
          const listed = yield* Effect.promise(() =>
            fetch(
              `${pds.url}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.example.note`,
            ).then((response) => response.json()),
          );
          return { applied, listed };
        }),
      ),
    );
    const uris = outcome.applied.results.map((one: { uri: string }) => one.uri);
    expect(new Set(uris).size).toBe(2);
    expect(outcome.applied.results[0].$type).toBe(
      'com.atproto.repo.applyWrites#createResult',
    );
    expect(outcome.listed.records).toHaveLength(2);
  });

  it('keeps Jetstream off unless named', async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const response = yield* Effect.promise(() =>
            fetch(`${pds.url}/jetstream/subscribe`),
          );
          return response.status;
        }),
      ),
    );
    expect(status).toBe(404);
  });
});
