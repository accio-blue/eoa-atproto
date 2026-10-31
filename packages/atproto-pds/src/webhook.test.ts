import { Kv, kvMemoryLayer } from '@eoa/kv';
import { describe, expect, it } from 'vitest';
import { flushWebhooks, siteOf, webhookNotifier } from './webhook.js';
import { Effect } from 'effect';

const kvOf = () =>
  Effect.runPromise(Effect.all({ kv: Kv }).pipe(Effect.provide(kvMemoryLayer)));

const HIDDEN = 'https://build.example/hook';

/**
 * Which writes are a site's business is the plugin's answer, not the PDS's — see
 * `@eoa/pds-cms` for the CMS's own rule. Here a plain prefix keeps the test about
 * the debounce, the site key and the send.
 */
const watched = (collection: string): boolean =>
  collection.startsWith('ing.lexicon.cms.');

describe('site build hooks', () => {
  it('waits out a burst, then sends one request and clears the row', async () => {
    const { kv } = await kvOf();
    const armed: number[] = [];
    const sent: Array<{
      readonly url: string;
      readonly body: string;
      readonly secret: string | undefined;
    }> = [];
    const notifier = webhookNotifier({
      kv,
      hooks: { 'did:plc:alice': HIDDEN },
      debounceMs: 1000,
      watched,
      arm: (at) => armed.push(at),
    });

    const event = {
      did: 'did:plc:alice',
      collection: 'ing.lexicon.cms.document',
      rkey: 'ru-home',
    };

    // A bulk edit: many writes, one window.
    await Effect.runPromise(notifier.note(event));
    await Effect.runPromise(notifier.note({ ...event, rkey: 'ru-about' }));
    expect(armed).toHaveLength(2);
    // Each write moves the deadline; the last one is the one that counts.
    expect(armed[1]).toBeGreaterThanOrEqual(armed[0] ?? 0);

    const before = Date.now();
    await Effect.runPromise(
      flushWebhooks({
        kv,
        hooks: { 'did:plc:alice': HIDDEN },
        now: before,
        post: async (params) => {
          sent.push(params);
        },
      }),
    );
    // The window has not closed yet, so nothing goes out.
    expect(sent).toHaveLength(0);

    await Effect.runPromise(
      flushWebhooks({
        kv,
        hooks: { 'did:plc:alice': HIDDEN },
        now: Date.now() + 5000,
        secret: 'the-secret',
        post: async (params) => {
          sent.push(params);
        },
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(HIDDEN);
    expect(sent[0]?.secret).toBe('the-secret');
    // The row named the last write of the burst, and the site — not the record —
    // is what the request is about.
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({
      site: 'did:plc:alice',
      did: 'did:plc:alice',
      rkey: 'ru-about',
    });

    // A cleared row means the next flush has nothing to say.
    const again = await Effect.runPromise(
      flushWebhooks({
        kv,
        hooks: { 'did:plc:alice': HIDDEN },
        now: Date.now() + 60000,
        post: async (params) => {
          sent.push(params);
        },
      }),
    );
    expect(again).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('ignores what is not a CMS record, and sites with no hook', async () => {
    const { kv } = await kvOf();
    const armed: number[] = [];
    const notifier = webhookNotifier({
      kv,
      hooks: { 'did:plc:alice': HIDDEN },
      debounceMs: 1000,
      watched,
      arm: (at) => armed.push(at),
    });

    await Effect.runPromise(
      notifier.note({
        did: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'abc',
      }),
    );
    await Effect.runPromise(
      notifier.note({
        did: 'did:plc:bob',
        collection: 'ing.lexicon.cms.document',
        rkey: 'ru-home',
      }),
    );

    expect(armed).toEqual([]);
  });

  it('asks the plugin about every write, and obeys a no', async () => {
    const { kv } = await kvOf();
    const armed: number[] = [];
    const asked: string[] = [];
    const notifier = webhookNotifier({
      kv,
      hooks: { 'did:plc:alice': HIDDEN },
      debounceMs: 1000,
      // A plugin that says no to this collection, and would say yes to another.
      watched: (collection) => {
        asked.push(collection);
        return false;
      },
      arm: (at) => armed.push(at),
    });

    await Effect.runPromise(
      notifier.note({
        did: 'did:plc:alice',
        collection: 'ing.lexicon.cms.draft',
        rkey: 'ru-home',
      }),
    );

    // The rule was asked, no row was written, no timer was armed.
    expect(asked).toEqual(['ing.lexicon.cms.draft']);
    expect(armed).toEqual([]);
  });

  it('still nudges for a published document', async () => {
    const { kv } = await kvOf();
    const armed: number[] = [];
    const sent: string[] = [];
    const notifier = webhookNotifier({
      kv,
      hooks: { 'did:plc:alice': HIDDEN },
      debounceMs: 1000,
      watched,
      arm: (at) => armed.push(at),
    });

    await Effect.runPromise(
      notifier.note({
        did: 'did:plc:alice',
        collection: 'ing.lexicon.cms.document',
        rkey: 'ru-home',
      }),
    );

    expect(armed).toHaveLength(1);
    await Effect.runPromise(
      flushWebhooks({
        kv,
        hooks: { 'did:plc:alice': HIDDEN },
        now: Date.now() + 60000,
        post: async (params) => {
          sent.push(params.url);
        },
      }),
    );
    expect(sent).toEqual([HIDDEN]);
  });

  it('names the site by its publication when the record has one', () => {
    expect(
      siteOf({
        did: 'did:plc:alice',
        collection: 'ing.lexicon.cms.document',
        rkey: 'ru-home',
        publication: 'at://did:plc:alice/site.standard.publication/koc',
      }),
    ).toBe('at://did:plc:alice/site.standard.publication/koc');
    expect(
      siteOf({
        did: 'did:plc:alice',
        collection: 'ing.lexicon.cms.document',
        rkey: 'ru-home',
      }),
    ).toBe('did:plc:alice');
  });
});
