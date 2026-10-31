import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { spaceHooksOf } from './space-hooks.js';
import { startMemoryPds } from './memory.js';

/**
 * Telling the readers a space's access changed (`frxd`, `p6wp`).
 *
 * The host cannot un-issue a credential, so this is the only way a deletion — or a policy rewritten
 * to stop naming an app — ends access before the token's two hours. What matters: it goes to the
 * authority's hook and nobody else's, the secret rides along, a hook that is down cannot fail the
 * change that already happened, and an update says what the policy now is.
 */

const AUTHORITY = 'did:plc:authority';
const SPACE = `at://${AUTHORITY}/com.example.space/club`;

const NARROWED = {
  $type: 'com.atproto.memberspace.policy',
  publicRead: true,
  allowedApps: [],
};

const recorder = (status: number) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}', { status }));
    },
  };
};

describe('telling the hooks a space changed', () => {
  it('posts the space, the authority, the action and the secret to that authority’s hook only', async () => {
    const one = recorder(200);
    const hooks = spaceHooksOf({
      hooks: {
        [AUTHORITY]: 'https://appview.test/space/changed',
        'did:plc:someone-else': 'https://elsewhere.test/space/changed',
      },
      secret: 'shh',
      fetch: one.fetch,
      now: () => 1_700_000_000_000,
    });

    await Effect.runPromise(
      hooks.notify({ space: SPACE, authority: AUTHORITY, action: 'revoked' }),
    );

    expect(one.calls).toHaveLength(1);
    const call = one.calls[0];
    expect(call?.url).toBe('https://appview.test/space/changed');
    expect(call?.init.headers).toMatchObject({ 'x-cms-secret': 'shh' });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      space: SPACE,
      authority: AUTHORITY,
      action: 'revoked',
      at: 1_700_000_000_000,
    });
  });

  it('carries the new policy when the policy is what changed', async () => {
    const one = recorder(200);
    const hooks = spaceHooksOf({
      hooks: { [AUTHORITY]: 'https://appview.test/space/changed' },
      secret: 'shh',
      fetch: one.fetch,
      now: () => 1,
    });
    await Effect.runPromise(
      hooks.notify({
        space: SPACE,
        authority: AUTHORITY,
        action: 'updated',
        policy: NARROWED,
      }),
    );
    expect(JSON.parse(String(one.calls[0]?.init.body))).toEqual({
      space: SPACE,
      authority: AUTHORITY,
      action: 'updated',
      policy: NARROWED,
      at: 1,
    });
  });

  it('says nothing when no hook is named for that authority', async () => {
    const one = recorder(200);
    const hooks = spaceHooksOf({
      hooks: { 'did:plc:someone-else': 'https://elsewhere.test/space/changed' },
      secret: 'shh',
      fetch: one.fetch,
    });
    await Effect.runPromise(
      hooks.notify({ space: SPACE, authority: AUTHORITY, action: 'revoked' }),
    );
    expect(one.calls).toHaveLength(0);
  });

  it('does not fail the change when the hook is down or refuses', async () => {
    const down = spaceHooksOf({
      hooks: { [AUTHORITY]: 'https://appview.test/space/changed' },
      secret: 'shh',
      fetch: () => Promise.reject(new Error('no route')),
    });
    await expect(
      Effect.runPromise(
        down.notify({ space: SPACE, authority: AUTHORITY, action: 'revoked' }),
      ),
    ).resolves.toBeUndefined();

    const refusing = spaceHooksOf({
      hooks: { [AUTHORITY]: 'https://appview.test/space/changed' },
      secret: 'shh',
      fetch: async () => new Response('{}', { status: 500 }),
    });
    await expect(
      Effect.runPromise(
        refusing.notify({
          space: SPACE,
          authority: AUTHORITY,
          action: 'revoked',
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

/** A PDS in memory that a test can create an account and a space on. */
const serve = (params: {
  readonly policy: unknown;
}): {
  readonly run: <A>(
    body: (held: {
      readonly url: string;
      readonly did: string;
      readonly token: string;
      readonly space: string;
      readonly bodies: ReadonlyArray<unknown>;
    }) => Effect.Effect<A>,
  ) => Promise<A>;
} => {
  const bodies: Array<unknown> = [];
  return {
    run: (body) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const hooks: Record<string, string> = {};
            const pds = yield* startMemoryPds({
              spaceHooks: spaceHooksOf({
                hooks,
                secret: 'shh',
                fetch: (_url, init) => {
                  bodies.push(JSON.parse(String(init.body)));
                  return Promise.resolve(new Response('{}', { status: 200 }));
                },
              }),
            });
            const created = yield* Effect.promise(() =>
              fetch(`${pds.url}/xrpc/com.atproto.server.createAccount`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  handle: 'alice.pds.test',
                  password: 'correct horse battery staple',
                }),
              }).then(
                (response) =>
                  response.json() as Promise<Record<string, string>>,
              ),
            );
            const did = created['did'] ?? '';
            const token = created['accessJwt'] ?? '';
            hooks[did] = 'https://appview.test/space/changed';
            const space = `at://${did}/com.example.space/club`;
            const made = yield* Effect.promise(() =>
              fetch(`${pds.url}/xrpc/com.atproto.space.createSpace`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  spaceType: 'com.example.space',
                  skey: 'club',
                  policy: params.policy,
                }),
              }),
            );
            expect(made.status).toBe(200);
            return yield* body({ url: pds.url, did, token, space, bodies });
          }),
        ),
      ),
  };
};

const post = (params: {
  readonly url: string;
  readonly token: string;
  readonly method: string;
  readonly body: unknown;
}) =>
  fetch(`${params.url}/xrpc/${params.method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify(params.body),
  });

describe('a delete, end to end', () => {
  it('tells the authority’s hook that the space is gone', async () => {
    const pds = serve({
      policy: { $type: 'com.atproto.memberspace.policy', publicRead: true },
    });
    const bodies = await pds.run((held) =>
      Effect.gen(function* () {
        const deleted = yield* Effect.promise(() =>
          post({
            url: held.url,
            token: held.token,
            method: 'com.atproto.space.deleteSpace',
            body: { space: held.space },
          }),
        );
        expect(deleted.status).toBe(200);
        return held.bodies;
      }),
    );
    expect(bodies).toEqual([
      expect.objectContaining({
        space: expect.stringContaining('/com.example.space/club'),
        action: 'revoked',
      }),
    ]);
  });
});

describe('an update, end to end', () => {
  it('replaces the policy, says what it is now, and says nothing when nothing changed', async () => {
    const pds = serve({
      policy: {
        $type: 'com.atproto.memberspace.policy',
        publicRead: true,
        allowedApps: ['did:web:appview.test'],
      },
    });
    const bodies = await pds.run((held) =>
      Effect.gen(function* () {
        const first = yield* Effect.promise(() =>
          post({
            url: held.url,
            token: held.token,
            method: 'com.atproto.space.updateSpace',
            body: { space: held.space, policy: NARROWED },
          }),
        );
        expect(first.status).toBe(200);
        // The same policy again is not a revision: no write, so no reason to shake the readers.
        const again = yield* Effect.promise(() =>
          post({
            url: held.url,
            token: held.token,
            method: 'com.atproto.space.updateSpace',
            body: { space: held.space, policy: NARROWED },
          }),
        );
        expect(again.status).toBe(200);
        return held.bodies;
      }),
    );
    expect(bodies).toEqual([
      expect.objectContaining({ action: 'updated', policy: NARROWED }),
    ]);
  });

  it('refuses a caller who is not the authority', async () => {
    const pds = serve({
      policy: { $type: 'com.atproto.memberspace.policy', publicRead: true },
    });
    const bodies = await pds.run((held) =>
      Effect.gen(function* () {
        const refused = yield* Effect.promise(() =>
          post({
            url: held.url,
            token: 'not-a-token',
            method: 'com.atproto.space.updateSpace',
            body: { space: held.space, policy: NARROWED },
          }),
        );
        expect(refused.status).toBeGreaterThanOrEqual(400);
        return held.bodies;
      }),
    );
    expect(bodies).toEqual([]);
  });
});
