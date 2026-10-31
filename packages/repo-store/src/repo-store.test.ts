import { CODEC_DAG_CBOR, cidFromDigest, formatCid } from '@eoa/core';
import { Effect, Layer, Option } from 'effect';
import { Kv, kvFilesystemLayer, kvMemoryLayer } from '@eoa/kv';
import { MstLeaf, type MstNodeEntry, MstSubtree, encodeNode } from './mst.js';
import { RepoStore, repoStoreLayer } from './repo-store.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const DID = 'did:plc:example';

/** A CID is content, so a test can mint one from a seed. */
const cid = (seed: number) =>
  cidFromDigest({
    codec: CODEC_DAG_CBOR,
    digest: new Uint8Array(32).fill(seed),
  });

const leafEntry = (key: string) => new MstLeaf({ key, value: cid(key.length) });

const subtree = (seed: number) => new MstSubtree({ subtree: cid(seed) });

/** A node's block, as the store keeps it. */
const block = (left: number | null, entries: ReadonlyArray<MstNodeEntry>) =>
  Effect.gen(function* () {
    const all: Array<MstNodeEntry> = [
      ...(left === null ? [] : [new MstSubtree({ subtree: cid(left) })]),
      ...entries,
    ];
    const encoded = yield* encodeNode(all);
    return { cid: formatCid(encoded.cid), bytes: encoded.bytes };
  });

/** The store over one Kv instance — the same one the test may also reach. */
const stack = Layer.merge(repoStoreLayer, kvMemoryLayer).pipe(
  Layer.provide(kvMemoryLayer),
);

const run = <A, E>(effect: Effect.Effect<A, E, RepoStore | Kv>) =>
  Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(stack)));

describe('the repo model on the KV', () => {
  it('round-trips a head, a record and an interior node', async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* RepoStore;
        const node = yield* block(null, [
          leafEntry('app.bsky.feed.post/a'),
          subtree(1),
        ]);
        yield* repo.setHead(DID, { root: 'bafycommit', rev: '3abc' });
        yield* repo.putRecords(DID, [
          { key: 'app.bsky.feed.post/a', value: bytes('post-a') },
        ]);
        yield* repo.putNode(DID, node.cid, node.bytes);
        return {
          head: yield* repo.head(DID),
          record: yield* repo.record(DID, 'app.bsky.feed.post/a'),
          stored: yield* repo.node(DID, node.cid),
        };
      }),
    );

    expect(
      Option.isSome(result.head) ? result.head.value.root : undefined,
    ).toBe('bafycommit');
    expect(
      Option.isSome(result.record) ? text(result.record.value) : undefined,
    ).toBe('post-a');
    expect(Option.isSome(result.stored)).toBe(true);
    expect(
      Option.isSome(result.stored) ? result.stored.value.length : 0,
    ).toBeGreaterThan(0);
  });

  it('stores a node that holds only leaves, because a CAR needs it', async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* RepoStore;
        const leafy = yield* block(null, [
          leafEntry('app.bsky.feed.post/a'),
          leafEntry('app.bsky.feed.post/b'),
        ]);
        yield* repo.putNode(DID, leafy.cid, leafy.bytes);
        const stored = yield* repo.node(DID, leafy.cid);
        return { stored };
      }),
    );

    // The reference writes these too — a captured CAR carries three of them —
    // and a tree that points at a node the bytes do not hold cannot be walked.
    expect(Option.isSome(result.stored)).toBe(true);
  });

  it('rebuilds the leaves between two keys from the R/ rows', async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* RepoStore;
        yield* repo.putRecords(DID, [
          { key: 'app.bsky.feed.post/a', value: bytes('a') },
          { key: 'app.bsky.feed.post/b', value: bytes('b') },
          { key: 'app.bsky.feed.post/c', value: bytes('c') },
          { key: 'app.bsky.feed.post/d', value: bytes('d') },
        ]);
        const between = yield* repo.leaves(
          DID,
          'app.bsky.feed.post/a',
          'app.bsky.feed.post/d',
        );
        return between.map((one) => `${one.key}=${text(one.value)}`);
      }),
    );

    expect(result).toEqual([
      'app.bsky.feed.post/b=b',
      'app.bsky.feed.post/c=c',
    ]);
  });

  it('loads a cold repo from one M/ scan, and nothing of a neighbour', async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* RepoStore;
        const one = yield* block(null, [
          leafEntry('app.bsky.feed.post/a'),
          subtree(2),
        ]);
        const two = yield* block(3, [leafEntry('app.bsky.feed.like/b')]);
        const other = yield* block(null, [
          leafEntry('elsewhere/x'),
          subtree(4),
        ]);
        yield* repo.setHead(DID, { root: 'bafycommit', rev: '1' });
        yield* repo.putNode(DID, one.cid, one.bytes);
        yield* repo.putNode(DID, two.cid, two.bytes);
        yield* repo.putNode('did:plc:other', other.cid, other.bytes);
        return yield* repo.load(DID);
      }),
    );

    expect(Option.isSome(result.head) ? result.head.value.rev : undefined).toBe(
      '1',
    );
    expect(result.nodes.map((one) => one.cid)).toHaveLength(2);
  });

  it('says so when a row is not the row it claims to be', async () => {
    const failure = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put(`h/${DID}`, bytes('not json at all'));
        const repo = yield* RepoStore;
        return yield* Effect.flip(repo.head(DID));
      }),
    );

    expect(failure._tag).toBe('CorruptRow');
  });

  it('sits on any backend: the repo survives a restart on the filesystem', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'repo-store-'));
    const onDisk = repoStoreLayer.pipe(
      Layer.provide(kvFilesystemLayer(directory)),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoStore;
          yield* repo.setHead(DID, { root: 'bafycommit', rev: '7' });
          yield* repo.putRecords(DID, [
            { key: 'app.bsky.feed.post/a', value: bytes('post-a') },
          ]);
        }).pipe(Effect.orDie, Effect.provide(onDisk)),
      );

      const after = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoStore;
          const head = yield* repo.head(DID);
          const record = yield* repo.record(DID, 'app.bsky.feed.post/a');
          return { head, record };
        }).pipe(Effect.orDie, Effect.provide(onDisk)),
      );

      expect(Option.isSome(after.head) ? after.head.value.rev : undefined).toBe(
        '7',
      );
      expect(
        Option.isSome(after.record) ? text(after.record.value) : undefined,
      ).toBe('post-a');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes a batch of records in one commit', async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* RepoStore;
        const at = yield* repo.putRecords(DID, [
          { key: 'app.bsky.feed.post/a', value: bytes('a') },
          { key: 'app.bsky.feed.post/b', value: bytes('b') },
        ]);
        const a = yield* repo.record(DID, 'app.bsky.feed.post/a');
        const b = yield* repo.record(DID, 'app.bsky.feed.post/b');
        return { at, a, b };
      }),
    );

    expect(result.at).toBe(1);
    expect(Option.isSome(result.a) ? text(result.a.value) : undefined).toBe(
      'a',
    );
    expect(Option.isSome(result.b) ? text(result.b.value) : undefined).toBe(
      'b',
    );
  });
});
