import {
  CODEC_DAG_CBOR,
  type CborValue,
  cidFromDigest,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import {
  IndexStore,
  type IndexStoreShape,
  indexStoreLayer,
} from './index-store.js';
import {
  type ObservedRecord,
  indexRecord,
  recordUri,
  recordsOfCommit,
} from './ingest.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import { encodeCar } from '@eoa/repo';

/**
 * The ingest's contract: a commit's CAR diff is decoded into the records its
 * operations name, and each observed record offers exactly the references it
 * carries under the source that carries them. A delete's documented behaviour -
 * it names no targets, so it retracts nothing - is asserted rather than assumed.
 */

const DID = 'did:plc:genesis';
const POST = 'at://did:plc:bob/app.bsky.feed.post/3k2la9x8w1';
const LIKED = 'at://did:plc:carol/app.bsky.feed.post/3jzsm4zqb2s2a';
const LIKE = 'at://did:plc:genesis/app.bsky.feed.like/abc';

/** One record block: its bytes, and the CID they hash to. */
const recordBlock = (record: CborValue) => {
  const bytes = encodeCbor(record);
  const digest = new Uint8Array(createHash('sha256').update(bytes).digest());
  return { bytes, cid: cidFromDigest({ codec: CODEC_DAG_CBOR, digest }) };
};

/** A CAR diff carrying the given records, and the CIDs of their blocks. */
const carWith = (records: readonly CborValue[]) => {
  const blocks = records.map(recordBlock);
  const root = recordBlock({ $type: 'app.bsky.feed.post' });

  return {
    blocks: encodeCar({ roots: [root.cid], blocks: [root, ...blocks] }),
    cids: blocks.map((block) => formatCid(block.cid)),
  };
};

/** Offer every record a commit observed, in order. */
const indexAll = (params: {
  readonly store: IndexStoreShape;
  readonly observed: readonly ObservedRecord[];
}) =>
  Effect.forEach(
    params.observed,
    (entry) => indexRecord({ store: params.store, observed: entry }),
    { discard: false },
  );

/** Run one scenario against a fresh store. */
const withStore = <A>(use: (store: IndexStoreShape) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* IndexStore;
      return yield* use(store);
    }).pipe(Effect.provide(indexStoreLayer)),
  );

describe('recordsOfCommit', () => {
  it('returns nothing for a commit with no operations', async () => {
    const { blocks } = carWith([]);

    const observed = await Effect.runPromise(
      recordsOfCommit({ did: DID, ops: [], blocks }),
    );

    expect(observed).toEqual([]);
  });

  it('ignores an operation whose block the CAR does not carry', async () => {
    const absent = recordBlock({ $type: 'app.bsky.feed.post', text: 'absent' });
    const { blocks } = carWith([]);

    const observed = await Effect.runPromise(
      recordsOfCommit({
        did: DID,
        ops: [
          {
            action: 'create',
            path: 'app.bsky.feed.post/absent',
            cid: formatCid(absent.cid),
          },
        ],
        blocks,
      }),
    );

    expect(observed).toEqual([]);
  });
});

describe('indexRecord', () => {
  it('indexes a create under the target its strongRef names', async () => {
    const record = { $type: 'app.bsky.feed.like', subject: { uri: POST } };
    const { blocks, cids } = carWith([record]);

    const result = await withStore((store) =>
      Effect.gen(function* () {
        const observed = yield* recordsOfCommit({
          did: DID,
          ops: [
            {
              action: 'create',
              path: 'app.bsky.feed.like/abc',
              cid: cids[0] ?? null,
            },
          ],
          blocks,
        });
        const targets = yield* indexAll({ store, observed });
        const backlinks = yield* store.backlinksOf(POST);
        return { observed, targets, backlinks };
      }),
    );

    expect(result.observed).toEqual([
      { did: DID, collection: 'app.bsky.feed.like', rkey: 'abc', record },
    ]);
    expect(result.targets).toEqual([[POST]]);
    expect(result.backlinks).toEqual([LIKE]);
  });

  it('offers both references a record carries', async () => {
    const record = { first: POST, second: { nested: LIKED } };
    const { blocks, cids } = carWith([record]);

    const result = await withStore((store) =>
      Effect.gen(function* () {
        const observed = yield* recordsOfCommit({
          did: DID,
          ops: [
            {
              action: 'create',
              path: 'app.bsky.feed.post/multi',
              cid: cids[0] ?? null,
            },
          ],
          blocks,
        });
        const targets = yield* indexAll({ store, observed });
        const post = yield* store.backlinksOf(POST);
        const liked = yield* store.backlinksOf(LIKED);
        return { targets, post, liked };
      }),
    );

    expect(result.targets).toEqual([[POST, LIKED]]);
    expect(result.post).toEqual([
      'at://did:plc:genesis/app.bsky.feed.post/multi',
    ]);
    expect(result.liked).toEqual([
      'at://did:plc:genesis/app.bsky.feed.post/multi',
    ]);
  });

  it('retracts what the index remembers, because a delete names no targets', async () => {
    const record = { $type: 'app.bsky.feed.like', subject: { uri: POST } };
    const { blocks, cids } = carWith([record]);

    const result = await withStore((store) =>
      Effect.gen(function* () {
        const created = yield* recordsOfCommit({
          did: DID,
          ops: [
            {
              action: 'create',
              path: 'app.bsky.feed.like/abc',
              cid: cids[0] ?? null,
            },
          ],
          blocks,
        });
        yield* indexAll({ store, observed: created });

        const deleted = yield* recordsOfCommit({
          did: DID,
          ops: [
            { action: 'delete', path: 'app.bsky.feed.like/abc', cid: null },
          ],
          blocks,
        });
        const retracted = yield* indexAll({ store, observed: deleted });
        const backlinks = yield* store.backlinksOf(POST);
        return { deleted, retracted, backlinks };
      }),
    );

    expect(result.deleted).toEqual([
      {
        did: DID,
        collection: 'app.bsky.feed.like',
        rkey: 'abc',
        record: undefined,
      },
    ]);
    // The commit cannot name the target -- the record is gone -- so the store answers with what it
    // offered from this source, and the backlink goes with the record.
    expect(result.retracted).toEqual([[POST]]);
    expect(result.backlinks).toEqual([]);
  });

  it('builds an AT-URI from the record it observed', () => {
    expect(
      recordUri({ did: DID, collection: 'app.bsky.feed.like', rkey: 'abc' }),
    ).toBe(LIKE);
  });
});
