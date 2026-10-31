import { AccountStore, accountStoreLayer } from './account-store.js';
import { BlobStore, blobStoreLayer } from './blob-store.js';
import { Effect, Layer, Option } from 'effect';
import {
  type OperatorDeps,
  accountOf,
  accountsOf,
  blobsOf,
  repoOf,
} from './operator.js';
import { RepoStore, createRepo, repoStoreLayer } from '@eoa/repo-store';
import { describe, expect, it } from 'vitest';
import { generateES256KeyPair } from '@eoa/crypto';
import { kvMemoryLayer } from '@eoa/kv';

const bytes = (value: string) => new TextEncoder().encode(value);

const ALICE = 'did:web:pds.example:alice';

const BOB = 'did:web:pds.example:bob';

const withStores = <A, E>(
  use: (deps: OperatorDeps) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const accounts = yield* AccountStore;
      const repo = yield* RepoStore;
      const blobs = yield* BlobStore;
      return yield* use({ accounts, repo, blobs });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(accountStoreLayer, repoStoreLayer, blobStoreLayer).pipe(
          Layer.provide(kvMemoryLayer),
        ),
      ),
    ),
  );

const register = (deps: OperatorDeps, did: string, handle: string) =>
  deps.accounts.create({
    did,
    handle,
    email: `${handle.split('.')[0]}@pds.example`,
    passwordHash: 'pbkdf2$1$salt$hash',
    inviteCode: undefined,
    inviteRequired: false,
    now: 1,
  });

describe('the operator view', () => {
  it('lists accounts in handle order, and reports one with what it holds', async () => {
    const report = await withStores((deps) =>
      Effect.gen(function* () {
        yield* register(deps, BOB, 'bob.pds.example');
        yield* register(deps, ALICE, 'alice.pds.example');
        yield* deps.accounts.putAppPassword(ALICE, {
          name: 'robot',
          digest: 'digest',
          privileged: false,
          createdAt: 1,
        });
        return {
          all: yield* accountsOf(deps),
          one: yield* accountOf(deps, 'alice.pds.example'),
          byDid: yield* accountOf(deps, ALICE),
          missing: yield* accountOf(deps, 'nobody.pds.example'),
        };
      }),
    );

    expect(report.all.map((one) => one.handle)).toEqual([
      'alice.pds.example',
      'bob.pds.example',
    ]);
    expect(
      Option.getOrThrow(report.one).appPasswords.map((one) => one.name),
    ).toEqual(['robot']);
    expect(Option.getOrThrow(report.byDid).account.did).toBe(ALICE);
    expect(Option.isNone(report.missing)).toBe(true);
  });

  it('reports a repo: its head, its collections, its records and its blobs', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const report = await withStores((deps) =>
      Effect.gen(function* () {
        yield* register(deps, ALICE, 'alice.pds.example');
        yield* createRepo({
          did: ALICE,
          signingKey: keys.privateKey,
          now: 1000,
          clockId: 0,
        }).pipe(Effect.provideService(RepoStore, deps.repo));
        yield* deps.repo.putRecords(ALICE, [
          { key: 'app.bsky.feed.post/one', value: bytes('one') },
          { key: 'app.bsky.feed.post/two', value: bytes('two') },
          { key: 'app.bsky.actor.profile/self', value: bytes('me') },
        ]);
        yield* deps.blobs.upload({
          did: ALICE,
          bytes: bytes('a picture'),
          mimeType: 'image/png',
          limit: 1024,
          now: 1000,
        });
        return {
          repo: yield* repoOf(deps, 'alice.pds.example'),
          blobs: yield* blobsOf(deps, ALICE),
          missing: yield* repoOf(deps, 'nobody.pds.example'),
        };
      }),
    );

    const repo = Option.getOrThrow(report.repo);
    expect(repo.did).toBe(ALICE);
    expect(repo.records).toBe(3);
    expect(repo.collections).toEqual([
      'app.bsky.actor.profile',
      'app.bsky.feed.post',
    ]);
    expect(repo.head.root).toMatch(/^bafy/u);
    expect(Option.getOrThrow(report.blobs).map((one) => one.mimeType)).toEqual([
      'image/png',
    ]);
    expect(Option.isNone(report.missing)).toBe(true);
  });
});
