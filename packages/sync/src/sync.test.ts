import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { SyncError } from './types.js';
import { startMemoryPds } from '@eoa/atproto-pds';
import { syncRepo } from './sync.js';

/**
 * The sync client against the Effect PDS over a real socket: an account with
 * two records is written over XRPC to a PDS in memory on an ephemeral port, and
 * `syncRepo` reads the repo back through `getLatestCommit` + `getRepo`.
 */

const POST = 'app.bsky.feed.post';

const xrpc = async (
  service: string,
  method: string,
  body: unknown,
  token?: string,
) => {
  const response = await fetch(`${service}/xrpc/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method}: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, string>;
};

/** A PDS in memory holding one account with two records, for the length of `body`. */
const withServedPds = <A, E>(
  body: (service: string, did: string) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pds = yield* startMemoryPds();
      const { did = '', accessJwt } = yield* Effect.promise(() =>
        xrpc(pds.url, 'com.atproto.server.createAccount', {
          handle: 'alice.pds.test',
          password: 'correct horse battery staple',
        }),
      );
      const put = (
        collection: string,
        rkey: string,
        record: Readonly<Record<string, string>>,
      ) =>
        Effect.promise(() =>
          xrpc(
            pds.url,
            'com.atproto.repo.putRecord',
            {
              repo: did,
              collection,
              rkey,
              record: { $type: collection, ...record },
            },
            accessJwt,
          ),
        );
      yield* put(POST, 'first', { text: 'hello' });
      yield* put('app.bsky.feed.like', 'like1', { subject: 'x' });
      return yield* body(pds.url, did);
    }).pipe(Effect.scoped),
  );

const sync = (params: Parameters<typeof syncRepo>[0]) =>
  syncRepo(params).pipe(Effect.provide(FetchHttpClient.layer));

describe('syncRepo against the Effect PDS', () => {
  it('downloads the repo and names every record', async () => {
    const [did, result] = await withServedPds((service, did) =>
      sync({ service, did }).pipe(
        Effect.map((result) => [did, result] as const),
      ),
    );
    expect(result.did).toBe(did);
    expect(result.unchanged).toBe(false);
    expect(result.head.startsWith('bafy')).toBe(true);
    expect(result.records.map((record) => record.uri)).toEqual([
      `at://${did}/app.bsky.feed.like/like1`,
      `at://${did}/${POST}/first`,
    ]);
    expect(result.records[1]?.value).toEqual({ $type: POST, text: 'hello' });
  });

  it('filters by collection and skips the download when since is the head', async () => {
    const [did, posts, again] = await withServedPds((service, did) =>
      Effect.gen(function* () {
        const posts = yield* sync({
          service,
          did: did,
          collections: [POST],
        });
        const again = yield* sync({
          service,
          did: did,
          since: posts.rev,
        });
        return [did, posts, again] as const;
      }),
    );
    expect(posts.records.map((record) => record.uri)).toEqual([
      `at://${did}/${POST}/first`,
    ]);
    expect(again).toMatchObject({
      unchanged: true,
      rev: posts.rev,
      records: [],
    });
  });

  it('fails with a download SyncError for an unknown repo', async () => {
    const error = await withServedPds((service) =>
      sync({ service, did: 'did:plc:nobody' }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SyncError);
    expect(error.options.operation).toBe('download');
  });
});
