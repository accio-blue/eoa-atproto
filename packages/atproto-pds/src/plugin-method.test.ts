import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { type PluginMethod } from './plugin-method.js';
import { startMemoryPds } from './memory.js';

/**
 * A plugin's method (`cms-workspace`), and the two things the seam owes it.
 *
 * A plugin gets an authenticated DID and its own repo — never a token, never a repo named in the
 * request. That is the whole reason the seam exists instead of plugins reaching into the server,
 * so it is what this watches: an anonymous call is refused, and a method reads the caller's
 * collection and nobody else's.
 */

const COLLECTION = 'com.example.note';

const echo: PluginMethod = {
  nsid: 'com.example.plugin.echo',
  handler: ({ did, collection }) =>
    Effect.gen(function* () {
      const notes = yield* collection(COLLECTION);
      return { did, notes: notes.map((one) => one.rkey) };
    }),
};

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const account = async (url: string, handle: string) => {
  const response = await post(`${url}/xrpc/com.atproto.server.createAccount`, {
    handle,
    password: 'correct horse battery staple',
  });
  const body = (await response.json()) as Record<string, string>;
  return { did: body['did'] ?? '', token: body['accessJwt'] ?? '' };
};

describe('a method a plugin adds', () => {
  it('answers the caller its own did and its own collection, and nobody else’s', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds({ methods: [echo] });
          const alice = yield* Effect.promise(() =>
            account(pds.url, 'alice.pds.test'),
          );
          const bob = yield* Effect.promise(() =>
            account(pds.url, 'bob.pds.test'),
          );
          const write = async (did: string, token: string, rkey: string) => {
            const response = await post(
              `${pds.url}/xrpc/com.atproto.repo.putRecord`,
              {
                repo: did,
                collection: COLLECTION,
                rkey,
                record: { $type: COLLECTION, text: rkey },
              },
              token,
            );
            expect(response.status).toBe(200);
          };
          yield* Effect.promise(() => write(alice.did, alice.token, 'mine'));
          yield* Effect.promise(() => write(bob.did, bob.token, 'theirs'));

          // Unauthenticated is refused by the seam, not by the plugin.
          const anonymous = yield* Effect.promise(() =>
            post(`${pds.url}/xrpc/com.example.plugin.echo`, {}),
          );
          expect(anonymous.status).toBe(401);

          const signed = yield* Effect.promise(() =>
            post(`${pds.url}/xrpc/com.example.plugin.echo`, {}, alice.token),
          );
          expect(signed.status).toBe(200);
          const answered = yield* Effect.promise(() => signed.json());
          expect(answered).toEqual({ did: alice.did, notes: ['mine'] });
        }),
      ),
    );
  });
});
