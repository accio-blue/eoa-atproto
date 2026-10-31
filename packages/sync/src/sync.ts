import { Effect, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { commitCid, getRecord, listRecords, repoFromCar } from '@eoa/repo';
import type { CborValue } from '@eoa/core';
import { SyncError } from './types.js';
import { formatCid } from '@eoa/core';

export interface SyncRepoParams {
  /** The PDS base URL, e.g. `http://localhost:3000`. */
  readonly service: string;
  readonly did: string;
  /** The `rev` already held; the repo is not downloaded when it is still the head. */
  readonly since?: string | undefined;
  /** Keep only these collections; every collection when absent. */
  readonly collections?: ReadonlyArray<string> | undefined;
}

export interface SyncedRecord {
  readonly uri: string;
  readonly cid: string;
  readonly value: CborValue;
}

export interface SyncResult {
  readonly did: string;
  /** The commit CID. */
  readonly head: string;
  readonly rev: string;
  /** Every record of the repo (empty when `unchanged`). */
  readonly records: ReadonlyArray<SyncedRecord>;
  /** `since` was still the head, so nothing was downloaded. */
  readonly unchanged: boolean;
}

const LatestCommit = Schema.Struct({ cid: Schema.String, rev: Schema.String });

const xrpc = (service: string, method: string, did: string) =>
  `${service.replace(/\/$/, '')}/xrpc/com.atproto.sync.${method}?did=${encodeURIComponent(did)}`;

/**
 * Sync one repository from a PDS over `com.atproto.sync`: `getLatestCommit`
 * to see whether `since` is still the head, then `getRepo` for the whole CAR,
 * read through `@eoa/repo` into the records the tree names.
 *
 * Requires an `HttpClient` (`FetchHttpClient.layer` in an app).
 */
export const syncRepo = Effect.fn('sync.syncRepo')(function* (
  params: SyncRepoParams,
) {
  const { did, service } = params;
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const download = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError(
        (cause) => new SyncError({ cause, operation: 'download', did }),
      ),
    );

  const latest = yield* download(
    client
      .get(xrpc(service, 'getLatestCommit', did))
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(LatestCommit))),
  );
  if (params.since !== undefined && latest.rev === params.since) {
    return {
      did,
      head: latest.cid,
      rev: latest.rev,
      records: [],
      unchanged: true,
    } satisfies SyncResult;
  }

  const bytes = yield* download(
    client
      .get(xrpc(service, 'getRepo', did))
      .pipe(Effect.flatMap((response) => response.arrayBuffer)),
  );
  const repo = yield* repoFromCar(new Uint8Array(bytes)).pipe(
    Effect.mapError(
      (cause) => new SyncError({ cause, operation: 'parse', did }),
    ),
  );
  const head = yield* commitCid(repo.commit).pipe(
    Effect.mapError(
      (cause) => new SyncError({ cause, operation: 'parse', did }),
    ),
  );

  const wanted = params.collections;
  const records = listRecords({ repo }).flatMap((leaf) => {
    const [collection = '', rkey = ''] = leaf.key.split('/');
    if (wanted !== undefined && !wanted.includes(collection)) {
      return [];
    }
    const value = getRecord({ repo, collection, rkey });
    return value === undefined
      ? []
      : [{ uri: `at://${did}/${leaf.key}`, cid: formatCid(leaf.value), value }];
  });

  return {
    did,
    head: formatCid(head),
    rev: repo.commit.rev,
    records,
    unchanged: false,
  } satisfies SyncResult;
});
