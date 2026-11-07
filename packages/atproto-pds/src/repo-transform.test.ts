import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { startMemoryPds } from './memory.js';

/**
 * A plugin `transform` may rewrite a record before it is committed (`395u`), and the caller has to
 * be able to tell *what* landed. The answer already carries the cid of the stored bytes rather than
 * of the submitted record — this pins that, because the difference is invisible until a plugin is
 * installed and a refactor that returned the input's cid would look perfectly fine otherwise.
 *
 * Bean `7kpy`.
 */

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
    body: (await response.json()) as Record<string, unknown>,
  };
};

const get = async (url: string, token?: string) => {
  const response = await fetch(url, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

/** A field of an answer as a string, without widening the helpers to `any`. */
const text = (body: Record<string, unknown>, key: string): string =>
  typeof body[key] === 'string' ? body[key] : '';

describe('a plugin that rewrites a record', () => {
  it('is visible in the answer: the cid is the stored record, not the sent one', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The plugin adds a field the caller never sent, which is the smallest rewrite that
          // changes the bytes — and therefore the cid.
          const pds = yield* startMemoryPds({
            plugins: {
              transform: (write) =>
                Effect.succeed({
                  ...(write.record as Record<string, unknown>),
                  rewritten: true,
                }),
            },
          });
          const account = yield* Effect.promise(() =>
            post(`${pds.url}/xrpc/com.atproto.server.createAccount`, {
              handle: 'alice.pds.test',
              password: 'correct horse battery staple',
            }),
          );
          expect(account.status).toBe(200);
          const did = text(account.body, 'did');
          const token = text(account.body, 'accessJwt');
          expect(did).not.toBe('');
          expect(token).not.toBe('');

          const created = yield* Effect.promise(() =>
            post(
              `${pds.url}/xrpc/com.atproto.repo.createRecord`,
              {
                repo: did,
                collection: 'app.example.note',
                record: { $type: 'app.example.note', text: 'hello' },
              },
              token,
            ),
          );
          expect(created.status).toBe(200);
          const uri = text(created.body, 'uri');
          const cid = text(created.body, 'cid');
          expect(uri).not.toBe('');
          expect(cid).not.toBe('');
          const rkey = uri.split('/').pop() ?? '';

          const read = yield* Effect.promise(() =>
            get(
              `${pds.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.example.note&rkey=${encodeURIComponent(rkey)}`,
              token,
            ),
          );
          expect(read.status).toBe(200);

          // The record reads back rewritten, and the create's cid names that record — not the one
          // the caller sent.
          const value = read.body['value'] as Record<string, unknown>;
          expect(value['rewritten']).toBe(true);
          expect(text(read.body, 'cid')).toBe(cid);
        }),
      ),
    );
  });
});
