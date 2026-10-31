import { CODEC_DAG_CBOR, cidFromDigest, formatCid } from '@eoa/core';
import { Effect, Layer, Match, Option } from 'effect';
import { Kv, kvMemoryLayer } from '@eoa/kv';
import { RepoStore, repoStoreLayer } from './repo-store.js';
import { addLeaves, emptyTree, encodeTree } from './mst-tree.js';
import { applyWrite, createRepo, writeConflicted } from './repo-write.js';
import { describe, expect, it } from 'vitest';
import { generateES256KeyPair, sha256 } from '@eoa/crypto';
import { MstLeaf } from './mst.js';
import type { PrivateKey } from '@eoa/crypto';

const DID = 'did:plc:example';

const stack = Layer.merge(repoStoreLayer, kvMemoryLayer).pipe(
  Layer.provide(kvMemoryLayer),
);

const run = <A, E>(effect: Effect.Effect<A, E, RepoStore | Kv>) =>
  Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(stack)));

/** A repo at its genesis, plus the key that signs it and a record to write. */
const seeded = () =>
  Effect.gen(function* () {
    const store = yield* RepoStore;
    const keys = yield* generateES256KeyPair();
    const genesis = yield* createRepo({
      did: DID,
      signingKey: keys.privateKey,
      now: 1000,
      clockId: 0,
    });
    return { store, keys, genesis };
  });

const write = (params: {
  readonly store: RepoStore['Service'];
  readonly keys: { readonly privateKey: PrivateKey };
  readonly swapCommit: string | undefined;
}) =>
  applyWrite({
    did: DID,
    key: 'app.bsky.feed.post/one',
    record: { text: 'hello' },
    swapCommit: params.swapCommit,
    signingKey: params.keys.privateKey,
    now: 2000,
    clockId: 0,
  });

describe('the write path, against repo-write.qnt', () => {
  // submit with no observed commit (`seen == -1`) validates.
  it('commits a write that observed nothing', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { store, keys, genesis } = yield* seeded();
        const outcome = yield* write({ store, keys, swapCommit: undefined });
        const head = yield* store.head(DID);
        const record = yield* store.record(DID, 'app.bsky.feed.post/one');
        return { outcome, genesis, head, record };
      }),
    );

    expect(result.outcome._tag).toBe('committed');
    expect(
      Option.isSome(result.head) ? result.head.value.root : undefined,
    ).not.toBe(result.genesis.commit);
    expect(
      Option.isSome(result.record) ? result.record.value.length : 0,
    ).toBeGreaterThan(0);
  });

  // submit with the current commit (`seen == commit`) validates too.
  it('commits a write that observed the current commit', async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const { store, keys, genesis } = yield* seeded();
        return yield* write({
          store,
          keys,
          swapCommit: genesis.commit,
        });
      }),
    );

    expect(outcome._tag).toBe('committed');
  });

  // submit with anything else is a conflict, and a conflict leaves the repo
  // untouched: `commit' = commit`, `record' = record`.
  it('conflicts on a stale commit, and leaves the repo alone', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { store, keys, genesis } = yield* seeded();
        const outcome = yield* write({
          store,
          keys,
          swapCommit: 'bafystale',
        });
        const head = yield* store.head(DID);
        const record = yield* store.record(DID, 'app.bsky.feed.post/one');
        return { outcome, genesis, head, record };
      }),
    );

    expect(result.outcome).toEqual(
      writeConflicted({ head: result.genesis.commit }),
    );
    expect(
      Option.isSome(result.head) ? result.head.value.root : undefined,
    ).toBe(result.genesis.commit);
    expect(Option.isNone(result.record)).toBe(true);
  });

  // commitWrite advances the commit by exactly one and leaves nothing dirty:
  // the head already points at the new commit, and the tree it names holds the
  // record.
  it('points the head at the new commit, whose tree holds the record', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { store, keys } = yield* seeded();
        const outcome = yield* write({ store, keys, swapCommit: undefined });
        const head = yield* store.head(DID);
        const record = yield* store.record(DID, 'app.bsky.feed.post/one');
        const stored = Option.isSome(record)
          ? yield* store.commit(DID, Option.isSome(head) ? head.value.root : '')
          : Option.none();
        const expected = yield* encodeTree(
          yield* addLeaves({
            node: emptyTree(),
            leaves: [
              new MstLeaf({
                key: 'app.bsky.feed.post/one',
                value: cidFromDigest({
                  codec: CODEC_DAG_CBOR,
                  digest: yield* sha256(
                    Option.isSome(record) ? record.value : new Uint8Array(),
                  ),
                }),
              }),
            ],
          }),
        );
        return { outcome, head, stored, expected };
      }),
    );

    expect(result.outcome._tag).toBe('committed');
    expect(Option.isSome(result.stored)).toBe(true);
    expect(Option.isSome(result.head) ? result.head.value.rev : undefined).toBe(
      Match.value(result.outcome).pipe(
        Match.tag('committed', (done) => done.rev),
        Match.orElse(() => ''),
      ),
    );
  });
});

describe('an empty repo', () => {
  it('keeps the empty tree root, so a reader can walk a repo that has no records', async () => {
    // A move off a fresh account hit this: `sync.getRepo` serves the blocks the store holds, and the
    // commit named an empty tree nobody had written — so the CAR arrived without its own root and the
    // destination refused it (`the CAR does not carry the node …`).
    const { store } = await run(seeded());
    const emptyRoot = await run(
      encodeTree(emptyTree()).pipe(
        Effect.map((encoded) => formatCid(encoded.root)),
      ),
    );

    const loaded = await run(store.load(DID));

    expect(loaded.nodes.map((node) => node.cid)).toEqual([emptyRoot]);
  });
});
