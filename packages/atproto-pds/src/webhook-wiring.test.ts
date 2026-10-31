import { AccountStore, accountStoreLayer } from './account-store.js';
import { BlobStore, blobStoreLayer } from './blob-store.js';
import { DpopReplay, dpopReplayLayer } from './dpop-replay.js';
import { Effect, Layer, Option, Schema } from 'effect';
import { Firehose, firehoseLayer } from './firehose.js';
import { Kv, kvMemoryLayer } from '@eoa/kv';
import { RepoStore, repoStoreLayer } from '@eoa/repo-store';
import { SpaceStore, spaceStoreLayer } from './space-store.js';
import { describe, expect, it } from 'vitest';
import type { PdsConfig } from './pds.js';
import type { PluginHooks } from './repo.js';
import type { WebhookEvent } from './webhook.js';
import { createPdsServer } from './server.js';
import { generateES256KeyPair } from '@eoa/crypto';

/**
 * The join between a write and a nudge: the notifier is tested on its own, and
 * this is the one thing that test cannot see — that the repo surface actually
 * tells it about a write, with the collection and the site.
 */

const DOMAIN = 'pds.example';

const ISSUER = `https://${DOMAIN}`;

const HANDLE = `alice.${DOMAIN}`;

const PASSWORD = 'correct horse battery staple';

const SessionSchema = Schema.Struct({
  accessJwt: Schema.String,
  did: Schema.String,
});

const sessionOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionSchema),
);

const withServer = async (
  body: (params: {
    readonly handle: (request: Request) => Promise<Response>;
    readonly did: string;
    readonly token: string;
    readonly noted: WebhookEvent[];
  }) => Promise<void>,
  plugins?: PluginHooks | undefined,
) => {
  const stack = Layer.mergeAll(
    repoStoreLayer,
    accountStoreLayer,
    blobStoreLayer,
    dpopReplayLayer,
    firehoseLayer(),
    spaceStoreLayer,
  ).pipe(Layer.provideMerge(kvMemoryLayer));
  const services = await Effect.runPromise(
    Effect.all({
      repo: RepoStore,
      accounts: AccountStore,
      blobs: BlobStore,
      replay: DpopReplay,
      firehose: Firehose,
      spaces: SpaceStore,
      kv: Kv,
    }).pipe(Effect.provide(stack)),
  );
  const signing = await Effect.runPromise(generateES256KeyPair());
  const noted: WebhookEvent[] = [];
  const config: PdsConfig = {
    did: `did:web:${DOMAIN}`,
    domain: DOMAIN,
    signingKey: signing.privateKey,
    clockId: 0,
  };
  const server = createPdsServer({
    config,
    repo: services.repo,
    accounts: services.accounts,
    blobs: services.blobs,
    replay: services.replay,
    firehose: services.firehose,
    mail: { send: () => Effect.void },
    spaces: services.spaces,
    webhooks: {
      note: (event) =>
        Effect.sync(() => {
          noted.push(event);
        }),
    },
    ...(plugins === undefined ? {} : { plugins }),
  });

  const created = await server.handle(
    new Request(`${ISSUER}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: HANDLE,
        email: 'alice@example.com',
        password: PASSWORD,
      }),
    }),
  );
  const session = sessionOf(await created.text());
  if (Option.isNone(session)) {
    throw new Error(`the account was not created: ${created.status}`);
  }

  await body({
    handle: (request) => server.handle(request),
    did: session.value.did,
    token: session.value.accessJwt,
    noted,
  });
};

describe('a write nudges the site', () => {
  it('tells the notifier which site and which record changed', async () => {
    await withServer(async ({ handle, did, token, noted }) => {
      const written = await handle(
        new Request(`${ISSUER}/xrpc/com.atproto.repo.putRecord`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            repo: did,
            collection: 'ing.lexicon.cms.document',
            rkey: 'ru-home',
            record: {
              $type: 'ing.lexicon.cms.document',
              type: 'page',
              uid: 'home',
              lang: 'ru',
              data: {},
              createdAt: '2024-01-01T00:00:00.000Z',
              publication: 'at://did:plc:alice/site.standard.publication/koc',
            },
          }),
        }),
      );
      expect(written.status).toBe(200);

      expect(noted).toHaveLength(1);
      expect(noted[0]).toMatchObject({
        did,
        collection: 'ing.lexicon.cms.document',
        rkey: 'ru-home',
        publication: 'at://did:plc:alice/site.standard.publication/koc',
      });

      // A delete is a change too: a site that only hears about writes keeps a
      // page that no longer exists.
      const removed = await handle(
        new Request(`${ISSUER}/xrpc/com.atproto.repo.deleteRecord`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            repo: did,
            collection: 'ing.lexicon.cms.document',
            rkey: 'ru-home',
          }),
        }),
      );
      expect(removed.status).toBe(200);
      expect(noted).toHaveLength(2);
      expect(noted[1]).toMatchObject({
        did,
        collection: 'ing.lexicon.cms.document',
        rkey: 'ru-home',
      });
    });
  });
});

describe('a write through the installed plugins', () => {
  const document = {
    $type: 'ing.lexicon.cms.document',
    type: 'page',
    uid: 'home',
    lang: 'ru',
    data: {},
    createdAt: '2024-01-01T00:00:00.000Z',
  };

  const put = async (params: {
    readonly handle: (request: Request) => Promise<Response>;
    readonly did: string;
    readonly token: string;
    readonly record: unknown;
  }) =>
    params.handle(
      new Request(`${ISSUER}/xrpc/com.atproto.repo.putRecord`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${params.token}`,
        },
        body: JSON.stringify({
          repo: params.did,
          collection: 'ing.lexicon.cms.document',
          rkey: 'ru-home',
          record: params.record,
        }),
      }),
    );

  const read = async (params: {
    readonly handle: (request: Request) => Promise<Response>;
    readonly did: string;
    readonly token: string;
  }) => {
    const read = await params.handle(
      new Request(
        `${ISSUER}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(params.did)}&collection=ing.lexicon.cms.document&rkey=ru-home`,
        { headers: { authorization: `Bearer ${params.token}` } },
      ),
    );
    return (await read.json()) as { value: Record<string, unknown> };
  };

  it('commits the record a transform returns, not the one the client sent', async () => {
    const seen: string[] = [];
    await withServer(
      async ({ handle, did, token }) => {
        const written = await put({
          handle,
          did,
          token,
          record: { ...document, tags: ['a'] },
        });
        expect(written.status).toBe(200);
        const stored = await read({ handle, did, token });
        expect(stored.value['tags']).toEqual(['a', 'stamped']);
      },
      {
        transform: (write) =>
          Effect.sync(() => {
            seen.push(write.rkey);
            return { ...(write.record as object), tags: ['a', 'stamped'] };
          }),
      },
    );
    expect(seen).toEqual(['ru-home']);
  });

  it('leaves the write alone when a transform fails', async () => {
    await withServer(
      async ({ handle, did, token }) => {
        const written = await put({
          handle,
          did,
          token,
          record: { ...document, tags: ['a'] },
        });
        expect(written.status).toBe(200);
        const stored = await read({ handle, did, token });
        expect(stored.value['tags']).toEqual(['a']);
      },
      {
        transform: () => Effect.fail(new Error('the plugin is broken')),
      },
    );
  });

  it('tells the observers what was committed, after the commit', async () => {
    const observed: Array<{ readonly rkey: string; readonly tags: unknown }> =
      [];
    await withServer(
      async ({ handle, did, token }) => {
        await put({ handle, did, token, record: document });
        // after the response, the observer has run: it is inline, not a floating promise
        expect(observed).toEqual([{ rkey: 'ru-home', tags: undefined }]);
      },
      {
        observed: (write) =>
          Effect.sync(() => {
            observed.push({
              rkey: write.rkey,
              tags: (write.record as { tags?: unknown }).tags,
            });
          }),
      },
    );
  });
});
