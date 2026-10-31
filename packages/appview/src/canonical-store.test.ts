import {
  type CanonicalRecord,
  CanonicalStore,
  type CanonicalStoreShape,
  canonicalStoreLayer,
} from './canonical-store.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

/**
 * The canonical store's contract: a URI holds one record, a write replaces,
 * and `list` pages one collection in `rkey` order with the PDS's cursor
 * convention. Every case runs inside one provided layer, since a `Layer.effect`
 * store is rebuilt per `Effect.provide`.
 */

const POST = 'app.bsky.feed.post';
const LIKE = 'app.bsky.feed.like';

const postUri = (rkey: string) => `at://did:plc:genesis/${POST}/${rkey}`;
const likeUri = (rkey: string) => `at://did:plc:genesis/${LIKE}/${rkey}`;

const post = (rkey: string) =>
  ({
    uri: postUri(rkey),
    cid: `bafy-${rkey}`,
    value: { $type: POST, text: rkey },
  }) satisfies CanonicalRecord;

const like = (rkey: string) =>
  ({
    uri: likeUri(rkey),
    cid: `bafy-${rkey}`,
    value: { $type: LIKE, subject: { uri: postUri('a') } },
  }) satisfies CanonicalRecord;

const ORIGINAL: CanonicalRecord = {
  uri: postUri('a'),
  cid: 'bafy-original',
  value: { $type: POST, text: 'original' },
};

const REPLACEMENT: CanonicalRecord = {
  uri: postUri('a'),
  cid: 'bafy-replacement',
  value: { $type: POST, text: 'replacement' },
};

/** Run one scenario against a fresh store. */
const withStore = <A>(use: (store: CanonicalStoreShape) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CanonicalStore;
      return yield* use(store);
    }).pipe(Effect.provide(canonicalStoreLayer)),
  );

describe('CanonicalStore', () => {
  it('returns what was applied', async () => {
    const got = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(ORIGINAL);
        return yield* store.get(ORIGINAL.uri);
      }),
    );

    expect(got).toEqual(ORIGINAL);
  });

  it('replaces a record applied twice without growing', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(ORIGINAL);
        yield* store.apply(REPLACEMENT);
        return {
          got: yield* store.get(ORIGINAL.uri),
          size: yield* store.size,
        };
      }),
    );

    expect(result.got).toEqual(REPLACEMENT);
    expect(result.size).toBe(1);
  });

  it('reports false when removing an unknown URI and leaves size alone', async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(ORIGINAL);
        const removed = yield* store.remove(postUri('missing'));
        return { removed, size: yield* store.size };
      }),
    );

    expect(result.removed).toBe(false);
    expect(result.size).toBe(1);
  });

  it('lists one collection in rkey order', async () => {
    const records = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(post('c'));
        yield* store.apply(like('z'));
        yield* store.apply(post('a'));
        yield* store.apply(post('b'));
        return yield* store.list({ collection: POST });
      }),
    );

    expect(records.records.map((record) => record.uri)).toEqual([
      postUri('a'),
      postUri('b'),
      postUri('c'),
    ]);
    expect(records.cursor).toBe('c');
  });

  it('filters a collection to one repo when asked', async () => {
    const other = (rkey: string) =>
      ({
        uri: `at://did:plc:other/${POST}/${rkey}`,
        cid: `bafy-other-${rkey}`,
        value: { $type: POST, text: rkey },
      }) satisfies CanonicalRecord;

    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(post('a'));
        yield* store.apply(other('a'));
        yield* store.apply(post('b'));
        const mine = yield* store.list({
          collection: POST,
          repo: 'did:plc:genesis',
        });
        const theirs = yield* store.list({
          collection: POST,
          repo: 'did:plc:other',
        });
        return { mine, theirs };
      }),
    );

    expect(result.mine.records.map((record) => record.uri)).toEqual([
      postUri('a'),
      postUri('b'),
    ]);
    expect(result.mine.cursor).toBe('b');
    expect(result.theirs.records.map((record) => record.uri)).toEqual([
      `at://did:plc:other/${POST}/a`,
    ]);
  });

  it('pages exactly with a cursor and a limit', async () => {
    const pages = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(post('a'));
        yield* store.apply(post('b'));
        yield* store.apply(post('c'));
        yield* store.apply(post('d'));
        yield* store.apply(post('e'));

        const first = yield* store.list({ collection: POST, limit: 2 });
        const second = yield* store.list({
          collection: POST,
          limit: 2,
          cursor: first.cursor,
        });
        return { first, second };
      }),
    );

    expect(pages.first.records.map((record) => record.uri)).toEqual([
      postUri('a'),
      postUri('b'),
    ]);
    expect(pages.first.cursor).toBe('b');
    expect(pages.second.records.map((record) => record.uri)).toEqual([
      postUri('c'),
      postUri('d'),
    ]);
    expect(pages.second.cursor).toBe('d');
  });

  it('keeps size exact after a mixed sequence', async () => {
    const size = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(ORIGINAL);
        yield* store.apply(post('b'));
        yield* store.apply(post('c'));
        yield* store.apply(REPLACEMENT);
        yield* store.remove(postUri('b'));
        yield* store.remove(postUri('never'));
        return yield* store.size;
      }),
    );

    expect(size).toBe(2);
  });

  it('rebuilds per Effect.provide', async () => {
    const inside = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply(ORIGINAL);
        return yield* store.size;
      }),
    );
    const fresh = await withStore((store) => store.size);

    expect(inside).toBe(1);
    expect(fresh).toBe(0);
  });
});
