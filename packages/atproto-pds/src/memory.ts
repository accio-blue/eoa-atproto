import { AccountStore, accountStoreLayer } from './account-store.js';
import { BlobStore, blobStoreLayer } from './blob-store.js';
import { DpopReplay, dpopReplayLayer } from './dpop-replay.js';
import { Effect, Layer } from 'effect';
import { Firehose, firehoseLayer } from './firehose.js';
import { Mail, noMailLayer } from './mail.js';
import { RepoStore, repoStoreLayer } from '@eoa/repo-store';
import { SpaceStore, spaceStoreLayer } from './space-store.js';
import type { SpaceSurfaceDeps } from './space.js';
import { createPdsServer } from './server.js';
import { generateES256KeyPair } from '@eoa/crypto';
import { kvMemoryLayer } from '@eoa/kv';

/**
 * A whole PDS in memory, listening on a port the OS picks: the same server a deployment runs, over
 * `kvMemoryLayer` instead of a Durable Object or a bucket. For a test that needs a real PDS over HTTP
 * and for a local network that should not outlive its process. It lives as long as its scope.
 */
export const startMemoryPds = (
  params: {
    readonly domain?: string;
    readonly jetstream?: boolean;
    readonly port?: number;
    readonly privateCollections?: readonly string[];
    /** How an app's proof is checked, when a test wants no network (`frxd`). */
    readonly appKeys?: SpaceSurfaceDeps['appKeys'];
    /** Who to tell when a space is deleted (`frxd`); absent means nobody. */
    readonly spaceHooks?: SpaceSurfaceDeps['spaceHooks'];
    /** How a managing app's `did#fragment` is resolved (`70cr`); a test passes one over a map. */
    readonly identity?: SpaceSurfaceDeps['identity'];
  } = {},
) =>
  Effect.gen(function* () {
    const domain = params.domain ?? 'pds.test';
    const services = yield* Effect.all({
      repo: RepoStore,
      accounts: AccountStore,
      blobs: BlobStore,
      replay: DpopReplay,
      firehose: Firehose,
      mail: Mail,
      spaces: SpaceStore,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          repoStoreLayer,
          accountStoreLayer,
          blobStoreLayer,
          dpopReplayLayer,
          firehoseLayer(),
          noMailLayer,
          spaceStoreLayer,
        ).pipe(Layer.provide(kvMemoryLayer)),
      ),
    );
    const keys = yield* generateES256KeyPair();
    const port = yield* createPdsServer({
      config: {
        did: `did:web:${domain}`,
        domain,
        signingKey: keys.privateKey,
        clockId: 0,
        jetstream: params.jetstream ?? false,
        ...(params.privateCollections === undefined
          ? {}
          : { privateCollections: params.privateCollections }),
      },
      ...services,
      ...(params.identity === undefined ? {} : { identity: params.identity }),
      ...(params.appKeys === undefined ? {} : { appKeys: params.appKeys }),
      ...(params.spaceHooks === undefined
        ? {}
        : { spaceHooks: params.spaceHooks }),
    }).start({ port: params.port ?? 0, hostname: '127.0.0.1' });
    return { url: `http://127.0.0.1:${port}`, port, ...services };
  });
