import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { startMemoryPds } from './memory.js';

/**
 * `swapRecord` (`8q8s`/`kv0d`): a write that names the cid it read happens only while that is
 * still what is there. Without it the CMS editor's "someone else changed this" cannot exist — and
 * before this test it did not: the PDS refused the parameter outright, so every save of an
 * existing document was a 400 and every overwrite was silent.
 */

const COLLECTION = 'ing.lexicon.cms.draft';

const post = async (
  url: string,
  token: string | undefined,
  body: Record<string, unknown>,
) => {
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
    body: (await response.json()) as Record<string, unknown>,
  };
};

describe('putRecord with a cid it expects to replace', () => {
  it('writes while the record is the one that was read, and refuses once it is not', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const created = yield* Effect.promise(() =>
            post(
              `${pds.url}/xrpc/com.atproto.server.createAccount`,
              undefined,
              {
                handle: 'alice.pds.test',
                password: 'correct horse battery staple',
              },
            ),
          );
          const did = String(created.body['did'] ?? '');
          const token = String(created.body['accessJwt'] ?? '');
          const put = (text: string, swapRecord?: string) =>
            Effect.promise(() =>
              post(`${pds.url}/xrpc/com.atproto.repo.putRecord`, token, {
                repo: did,
                collection: COLLECTION,
                rkey: 'en-home',
                record: {
                  $type: COLLECTION,
                  type: 'page',
                  uid: 'home',
                  lang: 'en',
                  data: { title: text },
                  createdAt: '2026-01-01T00:00:00.000Z',
                },
                ...(swapRecord === undefined ? {} : { swapRecord }),
              }),
            );

          const first = yield* put('one');
          expect(first.status).toBe(200);
          const firstCid = String(first.body['cid'] ?? '');
          expect(firstCid).not.toBe('');

          // The cid it just read: the write is a replacement of *that* version.
          const second = yield* put('two', firstCid);
          expect(second.status).toBe(200);

          // The same cid again is stale now, and the record must say what it found.
          const stale = yield* put('three', firstCid);
          expect(stale.status).toBe(400);
          expect(stale.body['error']).toBe('InvalidSwap');
          expect(String(stale.body['message'])).toContain(firstCid);

          // Nothing moved: the third write never happened.
          const read = yield* Effect.promise(() =>
            fetch(
              `${pds.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${COLLECTION}&rkey=en-home`,
              { headers: { authorization: `Bearer ${token}` } },
            ).then(
              (response) => response.json() as Promise<Record<string, unknown>>,
            ),
          );
          expect(read['cid']).toBe(second.body['cid']);
        }),
      ),
    );
  });

  it('refuses a swap against a record that does not exist', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const created = yield* Effect.promise(() =>
            post(
              `${pds.url}/xrpc/com.atproto.server.createAccount`,
              undefined,
              {
                handle: 'alice.pds.test',
                password: 'correct horse battery staple',
              },
            ),
          );
          const put = yield* Effect.promise(() =>
            post(
              `${pds.url}/xrpc/com.atproto.repo.putRecord`,
              String(created.body['accessJwt'] ?? ''),
              {
                repo: String(created.body['did'] ?? ''),
                collection: COLLECTION,
                rkey: 'en-home',
                swapRecord: 'bafynothing',
                record: {
                  $type: COLLECTION,
                  type: 'page',
                  uid: 'home',
                  lang: 'en',
                  data: {},
                  createdAt: '2026-01-01T00:00:00.000Z',
                },
              },
            ),
          );
          expect(put.status).toBe(400);
          expect(put.body['error']).toBe('InvalidSwap');
          expect(String(put.body['message'])).toContain('absent');
        }),
      ),
    );
  });
});
