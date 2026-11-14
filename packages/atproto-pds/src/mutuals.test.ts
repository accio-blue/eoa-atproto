import { Effect, Exit } from 'effect';
import {
  FOLLOW_PAGE_LIMIT,
  FollowsUnreadable,
  liveFollows,
  mutualRule,
} from './mutuals.js';
import { describe, expect, it } from 'vitest';
import { DefaultIdentityResolver } from '@eoa/identity';
import { type DidDocument } from './proof.js';
import { startMemoryPds } from './memory.js';

/**
 * The mutuals oracle (`mqu7`): the follow graph answers `checkAccess`, and only the token can
 * refuse it.
 *
 * Two halves are tested separately and then together: the rule and the graph read need no server,
 * the route needs one, and the last test lets a managed space on this host ask this host and read a
 * record it has no grant for.
 */

const HOST = 'did:web:pds.test';
const SPACE_TYPE = 'com.example.space';
/** What a managed space names when this host is its managing app. */
const MANAGING_APP = `${HOST}#atproto_pds`;
const AUTHORITY = 'did:web:authority.example';
const USER = 'did:plc:alice';

/** An identity resolver whose `did:web` documents all point at one endpoint. */
const resolverTo = (endpoint: () => string) =>
  new DefaultIdentityResolver(
    {
      lookupTxt: () => Effect.succeed([]),
      fetchWellKnown: () => Effect.succeed(undefined),
    },
    {
      fetchDocument: (did) =>
        Effect.succeed(
          JSON.stringify({
            id: did,
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: endpoint(),
              },
            ],
          }),
        ),
    },
  );

/** A `listRecords` page carrying follows of the given subjects. */
const page = (subjects: ReadonlyArray<string>, cursor?: string) =>
  JSON.stringify({
    records: subjects.map((subject) => ({
      uri: 'at://x/app.bsky.graph.follow/1',
      cid: 'bafy',
      value: {
        $type: 'app.bsky.graph.follow',
        subject,
        createdAt: '2026-11-12T00:00:00.000Z',
      },
    })),
    ...(cursor === undefined ? {} : { cursor }),
  });

describe('the rule: a mutual follows back', () => {
  const readsOf = (graphs: Readonly<Record<string, ReadonlyArray<string>>>) => {
    const asked: string[] = [];
    return {
      asked,
      follows: (did: string) => {
        asked.push(did);
        const subjects = graphs[did];
        return subjects === undefined
          ? Effect.fail(new FollowsUnreadable({ reason: 'unreadable' }))
          : Effect.succeed(new Set(subjects));
      },
    };
  };

  it('is true when both follow each other', async () => {
    const one = readsOf({ [AUTHORITY]: [USER], [USER]: [AUTHORITY] });
    expect(
      await Effect.runPromise(
        mutualRule({ authority: AUTHORITY, user: USER, follows: one.follows }),
      ),
    ).toBe(true);
  });

  it('is false when only one side follows', async () => {
    const missingUser = readsOf({ [AUTHORITY]: [], [USER]: [AUTHORITY] });
    expect(
      await Effect.runPromise(
        mutualRule({
          authority: AUTHORITY,
          user: USER,
          follows: missingUser.follows,
        }),
      ),
    ).toBe(false);

    const missingAuthority = readsOf({ [AUTHORITY]: [USER], [USER]: [] });
    expect(
      await Effect.runPromise(
        mutualRule({
          authority: AUTHORITY,
          user: USER,
          follows: missingAuthority.follows,
        }),
      ),
    ).toBe(false);
  });

  it('is true for the authority itself, without reading anything', async () => {
    const one = readsOf({});
    expect(
      await Effect.runPromise(
        mutualRule({
          authority: AUTHORITY,
          user: AUTHORITY,
          follows: one.follows,
        }),
      ),
    ).toBe(true);
    expect(one.asked).toEqual([]);
  });

  it('is false when either read fails', async () => {
    const authorityFails = readsOf({ [USER]: [AUTHORITY] });
    expect(
      await Effect.runPromise(
        mutualRule({
          authority: AUTHORITY,
          user: USER,
          follows: authorityFails.follows,
        }),
      ),
    ).toBe(false);

    const userFails = readsOf({ [AUTHORITY]: [USER] });
    expect(
      await Effect.runPromise(
        mutualRule({
          authority: AUTHORITY,
          user: USER,
          follows: userFails.follows,
        }),
      ),
    ).toBe(false);
  });
});

describe('the graph read: listRecords at the DID’s own PDS', () => {
  const resolver = resolverTo(() => 'https://pds.example');
  const failed = (effect: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromiseExit(effect).then(Exit.isFailure);

  const fetchOf = (answers: ReadonlyArray<string>, status = 200) => {
    const urls: URL[] = [];
    return {
      urls,
      fetchImpl: (input: string | URL | Request) => {
        const url = new URL(String(input));
        urls.push(url);
        const answer = answers[urls.length - 1] ?? '{}';
        return Promise.resolve(new Response(answer, { status }));
      },
    };
  };

  it('collects two pages in order, asking for the next from the cursor it was given', async () => {
    const one = fetchOf([
      page(['did:plc:a', 'did:plc:b'], 'page-2'),
      page(['did:plc:c']),
    ]);
    const follows = await Effect.runPromise(
      liveFollows({
        did: AUTHORITY,
        identity: resolver,
        fetchImpl: one.fetchImpl,
      }),
    );

    expect([...follows]).toEqual(['did:plc:a', 'did:plc:b', 'did:plc:c']);
    expect(one.urls).toHaveLength(2);
    expect(one.urls[0]?.origin).toBe('https://pds.example');
    expect(one.urls[0]?.searchParams.get('repo')).toBe(AUTHORITY);
    expect(one.urls[0]?.searchParams.get('collection')).toBe(
      'app.bsky.graph.follow',
    );
    expect(one.urls[0]?.searchParams.get('cursor')).toBeNull();
    expect(one.urls[1]?.searchParams.get('cursor')).toBe('page-2');
  });

  it('stops at its page cap rather than reading a graph forever', async () => {
    // Every page names another one: nothing tells the reader it is done.
    const one = fetchOf(
      Array.from({ length: FOLLOW_PAGE_LIMIT + 5 }, (_unused, at) =>
        page(['did:plc:a'], `page-${at}`),
      ),
    );
    expect(
      await failed(
        liveFollows({
          did: AUTHORITY,
          identity: resolver,
          fetchImpl: one.fetchImpl,
        }),
      ),
    ).toBe(true);
    expect(one.urls).toHaveLength(FOLLOW_PAGE_LIMIT);
  });

  it('turns a non-200 into an error, never an empty follow set', async () => {
    const one = fetchOf(['no'], 500);
    expect(
      await failed(
        liveFollows({
          did: AUTHORITY,
          identity: resolver,
          fetchImpl: one.fetchImpl,
        }),
      ),
    ).toBe(true);
    // ... and the rule sees the failure as a no, because an unreadable graph is no answer.
    expect(
      await Effect.runPromise(
        mutualRule({
          authority: AUTHORITY,
          user: USER,
          follows: (did) =>
            liveFollows({
              did,
              identity: resolver,
              fetchImpl: one.fetchImpl,
            }),
        }),
      ),
    ).toBe(false);
  });
});

/** The account a createAccount call made. */
interface Account {
  readonly did: string;
  readonly accessJwt: string;
}

const createAccount = async (url: string, handle: string): Promise<Account> => {
  const response = await fetch(`${url}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, password: 'correct horse battery staple' }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const body = (await response.json()) as Record<string, string>;
  return { did: body['did'] ?? '', accessJwt: body['accessJwt'] ?? '' };
};

/** The consultation the route is asked with. */
const checkAccess = async (
  url: string,
  query: Readonly<Record<string, string>>,
  token?: string,
) => {
  const response = await fetch(
    `${url}/xrpc/com.atproto.managedspace.checkAccess?${new URLSearchParams(query)}`,
    token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${token}` } },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

/** A service-auth token minted by an account here, for the audience the route is asked with. */
const serviceAuth = async (params: {
  readonly url: string;
  readonly accessJwt: string;
  readonly aud?: string;
  readonly lxm?: string;
}) => {
  const query = new URLSearchParams({
    aud: params.aud ?? MANAGING_APP,
    lxm: params.lxm ?? 'com.atproto.managedspace.checkAccess',
  });
  const response = await fetch(
    `${params.url}/xrpc/com.atproto.server.getServiceAuth?${query}`,
    { headers: { authorization: `Bearer ${params.accessJwt}` } },
  );
  const body = (await response.json()) as Record<string, string>;
  return body['token'] ?? '';
};

/** The host's own signing key, as its document names it: what `proofOfControl` verifies against. */
const hostKeyOf = async (url: string, accessJwt: string) => {
  const response = await fetch(
    `${url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`,
    { headers: { authorization: `Bearer ${accessJwt}` } },
  );
  const body = (await response.json()) as {
    verificationMethods?: { atproto?: string };
  };
  return (body.verificationMethods?.atproto ?? '').replace(/^did:key:/u, '');
};

/** A whole PDS whose documents answer from memory, so a proof needs no network. */
const withOracle = async (
  run: (params: {
    readonly url: string;
    readonly authority: Account;
    readonly user: Account;
    readonly space: string;
  }) => Promise<void>,
) => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let url = '';
        let proof: DidDocument | undefined;
        const identity = resolverTo(() => url);
        const pds = yield* startMemoryPds({
          identity,
          fetchDocument: async () => {
            if (proof === undefined) {
              throw new Error('the test has not read the host key yet');
            }
            return proof;
          },
        });
        url = pds.url;
        const authority = yield* Effect.promise(() =>
          createAccount(pds.url, 'alice.pds.test'),
        );
        const user = yield* Effect.promise(() =>
          createAccount(pds.url, 'bob.pds.test'),
        );
        const publicKeyMultibase = yield* Effect.promise(() =>
          hostKeyOf(pds.url, authority.accessJwt),
        );
        proof = {
          verificationMethod: [{ id: '#atproto', publicKeyMultibase }],
        };
        yield* Effect.promise(() =>
          run({
            url: pds.url,
            authority,
            user,
            space: `at://${authority.did}/${SPACE_TYPE}/mutuals`,
          }),
        );
      }),
    ),
  );
};

describe('the route: only the token refuses', () => {
  it('is 401 with no token at all', async () => {
    await withOracle(async ({ url, user, space }) => {
      const answer = await checkAccess(url, {
        space,
        repo: user.did,
      });
      expect(answer.status).toBe(401);
      expect(answer.body).not.toHaveProperty('read');
    });
  });

  it('is 401 for a token issued by someone other than the space’s authority', async () => {
    await withOracle(async ({ url, user, space }) => {
      const token = await serviceAuth({ url, accessJwt: user.accessJwt });
      const answer = await checkAccess(url, { space, repo: user.did }, token);
      expect(answer.status).toBe(401);
      expect(answer.body).not.toHaveProperty('read');
    });
  });

  it('is 401 for a token minted for another method', async () => {
    await withOracle(async ({ url, authority, user, space }) => {
      const token = await serviceAuth({
        url,
        accessJwt: authority.accessJwt,
        lxm: 'com.atproto.repo.listRecords',
      });
      const answer = await checkAccess(url, { space, repo: user.did }, token);
      expect(answer.status).toBe(401);
      expect(answer.body).not.toHaveProperty('read');
    });
  });

  it('answers 200 { read: false, write: false } when nothing is mutual', async () => {
    await withOracle(async ({ url, authority, user, space }) => {
      const token = await serviceAuth({ url, accessJwt: authority.accessJwt });
      const answer = await checkAccess(url, { space, repo: user.did }, token);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ read: false, write: false });
    });
  });

  it('answers 200 { read: true, write: true } when both follow each other', async () => {
    await withOracle(async ({ url, authority, user, space }) => {
      const follow = async (follower: Account, subject: string) => {
        const response = await fetch(
          `${url}/xrpc/com.atproto.repo.createRecord`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${follower.accessJwt}`,
            },
            body: JSON.stringify({
              repo: follower.did,
              collection: 'app.bsky.graph.follow',
              record: {
                $type: 'app.bsky.graph.follow',
                subject,
                createdAt: new Date().toISOString(),
              },
            }),
          },
        );
        expect(response.status).toBe(200);
      };
      await follow(authority, user.did);
      await follow(user, authority.did);

      const token = await serviceAuth({ url, accessJwt: authority.accessJwt });
      const answer = await checkAccess(url, { space, repo: user.did }, token);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ read: true, write: true });
    });
  });

  it('answers both true when no repo is named, which is the authority itself', async () => {
    await withOracle(async ({ url, authority, space }) => {
      const token = await serviceAuth({ url, accessJwt: authority.accessJwt });
      const answer = await checkAccess(url, { space }, token);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ read: true, write: true });
    });
  });
});

describe('the two halves fit: a mutuals space reads itself', () => {
  it('lets a mutual read a managed space with no grant, and refuses a stranger', async () => {
    await withOracle(async ({ url, authority, user, space }) => {
      const created = await fetch(`${url}/xrpc/com.atproto.space.createSpace`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${authority.accessJwt}`,
        },
        body: JSON.stringify({
          spaceType: SPACE_TYPE,
          skey: 'mutuals',
          policy: {
            $type: 'com.atproto.managedspace.policy',
            managingApp: MANAGING_APP,
          },
        }),
      });
      expect(created.status).toBe(200);

      const written = await fetch(
        `${url}/xrpc/com.atproto.space.createRecord`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${authority.accessJwt}`,
          },
          body: JSON.stringify({
            space,
            repo: authority.did,
            collection: 'com.example.note',
            rkey: 'one',
            record: { $type: 'com.example.note', text: 'for my mutuals' },
          }),
        },
      );
      expect(written.status).toBe(200);

      const list = `com.atproto.space.listRecords?${new URLSearchParams({
        space,
        repo: authority.did,
        collection: 'com.example.note',
      })}`;
      const listed = () =>
        fetch(`${url}/xrpc/${list}`, {
          headers: { authorization: `Bearer ${user.accessJwt}` },
        });

      // Nothing mutual yet: the managing app says no, and with no grant the read is refused.
      // The reason has to be the app's own "no", not a refused token: that is the half that landed.
      const refused = await listed();
      expect(refused.status).toBe(403);
      const refusedBody = (await refused.json()) as { message?: string };
      expect(refusedBody.message).toContain('the-app-denied');

      const follow = async (follower: Account, subject: string) => {
        const response = await fetch(
          `${url}/xrpc/com.atproto.repo.createRecord`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${follower.accessJwt}`,
            },
            body: JSON.stringify({
              repo: follower.did,
              collection: 'app.bsky.graph.follow',
              record: {
                $type: 'app.bsky.graph.follow',
                subject,
                createdAt: new Date().toISOString(),
              },
            }),
          },
        );
        expect(response.status).toBe(200);
      };
      await follow(authority, user.did);
      await follow(user, authority.did);

      // The same read, now that they are mutuals: no member row, no grant, no second app.
      const allowed = await listed();
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as {
        records?: ReadonlyArray<{ rkey: string }>;
      };
      expect(body.records?.map((one) => one.rkey)).toEqual(['one']);
    });
  });

  it('does not exist on a host with no identity resolver', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const response = yield* Effect.promise(() =>
            fetch(
              `${pds.url}/xrpc/com.atproto.managedspace.checkAccess?space=at://${AUTHORITY}/${SPACE_TYPE}/mutuals&repo=${USER}`,
            ),
          );
          expect(response.status).toBe(404);
        }),
      ),
    );
  });
});
