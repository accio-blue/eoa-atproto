import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { startMemoryPds } from './memory.js';

// A closed network's tracker is not public: the collections a deployment names are answered only to
// a session, and the repo as a whole with them -- a CAR carries every collection at once.

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
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
};

const account = (pds: { url: string }, handle: string) =>
  post(`${pds.url}/xrpc/com.atproto.server.createAccount`, {
    handle,
    password: 'correct horse battery staple',
  });

describe('a deployment that keeps collections private', () => {
  it('answers them -- and the whole repo -- only to a session', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds({
            privateCollections: ['ing.lexicon.issue'],
          });
          const alice = yield* Effect.promise(() =>
            account(pds, 'alice.pds.test'),
          );
          const bob = yield* Effect.promise(() => account(pds, 'bob.pds.test'));
          const did = String(alice.body['did']);
          const aliceToken = String(alice.body['accessJwt']);

          yield* Effect.promise(() =>
            post(
              `${pds.url}/xrpc/com.atproto.repo.createRecord`,
              {
                repo: did,
                collection: 'ing.lexicon.issue',
                record: { $type: 'ing.lexicon.issue', title: 'not public' },
              },
              aliceToken,
            ),
          );

          // A listed collection, its sub-collections, and the record itself: 401 without a session.
          for (const collection of [
            'ing.lexicon.issue',
            'ing.lexicon.issue.state',
          ]) {
            const closed = yield* Effect.promise(() =>
              get(
                `${pds.url}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${collection}`,
              ),
            );
            expect(closed.status).toBe(401);
            expect(closed.body['error']).toBe('AuthRequired');
          }

          const closedRecord = yield* Effect.promise(() =>
            get(
              `${pds.url}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=ing.lexicon.issue&rkey=anything`,
            ),
          );
          expect(closedRecord.status).toBe(401);

          // Any session reads it -- the org's tracker is not the writer's private file.
          const opened = yield* Effect.promise(() =>
            get(
              `${pds.url}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=ing.lexicon.issue`,
              String(bob.body['accessJwt']),
            ),
          );
          expect(opened.status).toBe(200);
          expect(opened.body['records']).toHaveLength(1);

          // A collection the deployment did not name stays as open as atproto makes it.
          const publicOne = yield* Effect.promise(() =>
            get(
              `${pds.url}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.example.note`,
            ),
          );
          expect(publicOne.status).toBe(200);

          // The CAR is every collection at once, so it cannot be served to nobody in particular.
          const closedCar = yield* Effect.promise(() =>
            get(`${pds.url}/xrpc/com.atproto.sync.getRepo?did=${did}`),
          );
          expect(closedCar.status).toBe(401);
          const openedCar = yield* Effect.promise(() =>
            get(
              `${pds.url}/xrpc/com.atproto.sync.getRepo?did=${did}`,
              aliceToken,
            ),
          );
          expect(openedCar.status).toBe(200);
        }),
      ),
    );
  });

  it('leaves a public deployment exactly as open as it was', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            account(pds, 'alice.pds.test'),
          );
          const did = String(alice.body['did']);
          const listed = yield* Effect.promise(() =>
            get(
              `${pds.url}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=ing.lexicon.issue`,
            ),
          );
          expect(listed.status).toBe(200);
          const car = yield* Effect.promise(() =>
            get(`${pds.url}/xrpc/com.atproto.sync.getRepo?did=${did}`),
          );
          expect(car.status).toBe(200);
        }),
      ),
    );
  });
});
