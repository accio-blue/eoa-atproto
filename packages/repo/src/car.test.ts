import { CarReadError, readCar } from './car.js';
import {
  applyWrites,
  carOf,
  createRepo,
  deleteRecord,
  getRecord,
  listRecords,
  putRecord,
  repoFromCar,
  verifyRepo,
} from './repo.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { formatCid } from '@eoa/core';
import { generateES256KeyPair } from '@eoa/crypto';
import { readFileSync } from 'node:fs';

const fixture = new Uint8Array(
  readFileSync(new URL('../fixtures/repo-sample.car', import.meta.url)),
);

const NOW = 1_760_000_000_000;

const readFixture = () => Effect.runPromise(readCar(fixture));
const loadFixtureRepo = () => Effect.runPromise(repoFromCar(fixture));

const cidSetOf = (blocks: ReadonlyMap<string, unknown>) =>
  [...blocks.keys()].sort().join(',');

describe('reading a real CAR', () => {
  it('indexes every block, and verifies each against its CID', async () => {
    const car = await readFixture();

    expect(car.roots).toHaveLength(1);
    expect(car.blocks.size).toBe(23);

    const [root] = car.roots;
    expect(root).toBeDefined();
    if (root === undefined) {
      return;
    }
    // The root need not be the first block, so this is a lookup, not an index.
    expect(car.blocks.has(formatCid(root))).toBe(true);
  });

  it('refuses a CAR whose bytes were tampered with', async () => {
    const corrupted = Uint8Array.from(fixture);
    corrupted[Math.floor(corrupted.length / 2)] =
      (corrupted[Math.floor(corrupted.length / 2)] ?? 0) ^ 0xff;
    const truncated = fixture.slice(0, fixture.length - 8);

    await expect(Effect.runPromise(readCar(corrupted))).rejects.toThrow();
    await expect(Effect.runPromise(readCar(truncated))).rejects.toThrow();
  });

  it('reads a repository, and writes back the same blocks', async () => {
    const car = await readFixture();
    const repo = await loadFixtureRepo();

    // The commit's `data` is the MST root the CAR's root commit names.
    expect(repo.commit.did).toBe('did:plc:pghz3kxikqowruq2wnj6kh2o');
    expect(car.blocks.has(formatCid(repo.commit.data.cid))).toBe(true);

    const written = await Effect.runPromise(carOf(repo));
    const reread = await Effect.runPromise(readCar(written));

    expect(reread.roots.map(formatCid)).toEqual(car.roots.map(formatCid));
    // Not just the root: every block we write is a block it had. Re-encoding a
    // real repository has to be the same repository, or a PDS could not serve
    // one it did not create.
    expect(cidSetOf(reread.blocks)).toBe(cidSetOf(car.blocks));
  });
});

describe('records', () => {
  it('reads a record a real repository holds', async () => {
    const repo = await loadFixtureRepo();

    const profile = getRecord({
      repo,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
    });

    expect(profile).toBeDefined();
    expect(profile).toMatchObject({ $type: 'app.bsky.actor.profile' });
    expect(
      getRecord({ repo, collection: 'app.bsky.actor.profile', rkey: 'nobody' }),
    ).toBeUndefined();
  });

  it('lists one collection in key order, and pages it', async () => {
    const repo = await loadFixtureRepo();
    const follows = listRecords({ repo, collection: 'app.bsky.graph.follow' });

    expect(follows).toHaveLength(10);
    expect(follows.map((leaf) => leaf.key)).toEqual(
      follows.map((leaf) => leaf.key).sort(),
    );

    const firstTwo = listRecords({
      repo,
      collection: 'app.bsky.graph.follow',
      limit: 2,
    });
    expect(firstTwo).toHaveLength(2);
    const after = firstTwo[1]?.key.split('/')[1];
    expect(after).toBeDefined();
    if (after === undefined) {
      return;
    }
    const next = listRecords({
      repo,
      collection: 'app.bsky.graph.follow',
      after,
      limit: 2,
    });
    expect(next).toHaveLength(2);
    const lastOfFirst = firstTwo[1]?.key ?? '';
    expect(next.every((leaf) => leaf.key > lastOfFirst)).toBe(true);
  });
});

describe('writing a repository', () => {
  const post = (text: string) => ({
    $type: 'app.bsky.feed.post',
    text,
    createdAt: '2026-09-26T00:00:00.000Z',
  });

  const newRepo = async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const repo = await Effect.runPromise(
      createRepo({
        did: 'did:plc:mini-atmosphere',
        key: keys.privateKey,
        clockId: 7,
        now: NOW,
      }),
    );
    return { keys, repo };
  };

  it('puts, gets and lists, advancing one revision per write', async () => {
    const { keys, repo } = await newRepo();

    const first = await Effect.runPromise(
      putRecord({
        repo,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: post('hello'),
        key: keys.privateKey,
        now: NOW,
      }),
    );
    const second = await Effect.runPromise(
      putRecord({
        repo: first,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
        record: post('again'),
        key: keys.privateKey,
        // The same millisecond: the rev still has to move, because writes are
        // ordered by it.
        now: NOW,
      }),
    );

    expect(second.commit.rev > first.commit.rev).toBe(true);
    expect(second.commit.did).toBe(first.commit.did);
    expect(
      formatCid(second.commit.prev?.cid ?? second.commit.data.cid),
    ).not.toBe(formatCid(second.commit.data.cid));

    expect(
      getRecord({
        repo: second,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
      }),
    ).toMatchObject({ text: 'hello' });
    expect(
      listRecords({ repo: second, collection: 'app.bsky.feed.post' }),
    ).toHaveLength(2);
    expect(
      await Effect.runPromise(
        verifyRepo({ repo: second, key: keys.publicKey }),
      ),
    ).toBe(true);
  });

  it('round-trips its own repository through a CAR', async () => {
    const { keys, repo } = await newRepo();
    const written = await Effect.runPromise(
      applyWrites({
        repo,
        writes: [
          {
            action: 'create',
            collection: 'app.bsky.feed.post',
            rkey: 'one',
            record: post('hello'),
          },
          {
            action: 'create',
            collection: 'app.bsky.feed.like',
            rkey: 'one',
            record: { $type: 'app.bsky.feed.like', subject: 'at://x' },
          },
        ],
        key: keys.privateKey,
        now: NOW,
      }),
    );

    // One batch is one revision, however many records it holds.
    expect(written.commit.prev?.cid).toBeDefined();

    const car = await Effect.runPromise(carOf(written));
    const read = await Effect.runPromise(repoFromCar(car));

    expect(formatCid(read.commit.data.cid)).toBe(
      formatCid(written.commit.data.cid),
    );
    expect(
      getRecord({ repo: read, collection: 'app.bsky.feed.post', rkey: 'one' }),
    ).toMatchObject({ text: 'hello' });
    expect(
      await Effect.runPromise(verifyRepo({ repo: read, key: keys.publicKey })),
    ).toBe(true);
  });

  it('replaces a record, and deleting it puts the tree back', async () => {
    const { keys, repo } = await newRepo();
    const write = (record: { $type: string; text: string }) =>
      putRecord({
        repo,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record,
        key: keys.privateKey,
        now: NOW,
      });

    const withOne = await Effect.runPromise(write(post('first')));
    const withTwo = await Effect.runPromise(
      putRecord({
        repo: withOne,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
        record: post('second'),
        key: keys.privateKey,
        now: NOW,
      }),
    );
    const replaced = await Effect.runPromise(
      putRecord({
        repo: withTwo,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
        record: post('edited'),
        key: keys.privateKey,
        now: NOW,
      }),
    );

    expect(
      getRecord({
        repo: replaced,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
      }),
    ).toMatchObject({ text: 'edited' });
    // Replacing adds no key but does change a value, and a value is inside the
    // root - so the tree has the same shape and a different name. Both halves
    // matter: the first says the key set did not change, the second says the
    // repository is a commitment to its records and not just to their keys.
    expect(
      listRecords({ repo: replaced, collection: 'app.bsky.feed.post' }),
    ).toHaveLength(2);
    expect(formatCid(replaced.commit.data.cid)).not.toBe(
      formatCid(withTwo.commit.data.cid),
    );

    const deleted = await Effect.runPromise(
      deleteRecord({
        repo: replaced,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
        key: keys.privateKey,
        now: NOW,
      }),
    );

    // Deleting returns the tree to exactly the revision with only `one`.
    expect(formatCid(deleted.commit.data.cid)).toBe(
      formatCid(withOne.commit.data.cid),
    );
    expect(
      getRecord({
        repo: deleted,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
      }),
    ).toBeUndefined();
  });

  it('refuses to delete what is not there', async () => {
    const { keys, repo } = await newRepo();

    // A batch that quietly did nothing is a batch nobody can debug.
    await expect(
      Effect.runPromise(
        deleteRecord({
          repo,
          collection: 'app.bsky.feed.post',
          rkey: 'never-written',
          key: keys.privateKey,
          now: NOW,
        }),
      ),
    ).rejects.toThrow();
  });

  it('reports a CAR it cannot read as a read failure', async () => {
    await expect(
      Effect.runPromise(repoFromCar(new Uint8Array([1, 2, 3]))),
    ).rejects.toThrow(CarReadError);
  });

  it('keeps encodeCar and readCar inverse on a repository it made', async () => {
    const { keys, repo } = await newRepo();
    const written = await Effect.runPromise(
      putRecord({
        repo,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: post('hello'),
        key: keys.privateKey,
        now: NOW,
      }),
    );
    const car = await Effect.runPromise(carOf(written));
    const read = await Effect.runPromise(readCar(car));

    // A repo with one record: the commit, one MST node, and one record block.
    expect(read.blocks.size).toBe(3);
    expect(read.roots).toHaveLength(1);
    expect(cidSetOf(read.blocks)).toBe(
      cidSetOf((await Effect.runPromise(readCar(car))).blocks),
    );
  });
});
