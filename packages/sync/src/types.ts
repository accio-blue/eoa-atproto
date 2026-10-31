import { DID } from '@eoa/core';
import { Effect } from 'effect';

// Firehose event types
export interface RepoCommit {
  readonly rev: string;
  readonly since?: string;
  readonly blocks: Uint8Array;
  readonly ops: readonly RepoOp[];
  readonly time: string;
}

export interface RepoOp {
  readonly action: 'create' | 'update' | 'delete';
  readonly path: string;
  readonly cid?: string;
  readonly prev?: string;
}

export interface IdentityEvent {
  readonly did: DID;
  readonly time: string;
  readonly kind: 'create' | 'update' | 'delete';
  readonly handle?: string;
  readonly pds?: string;
}

export interface FirehoseEvent {
  readonly $type: string;
  readonly time_us: number;
  readonly did: DID;
  readonly commit?: RepoCommit;
  readonly identity?: IdentityEvent;
}

// Firehose subscription options
export interface FirehoseOptions {
  readonly cursor?: string;
  readonly filter?: FirehoseFilter;
  readonly backfill?: boolean;
}

// Firehose filter options
export interface FirehoseFilter {
  readonly collections?: readonly string[];
  readonly dids?: readonly DID[];
  readonly actions?: readonly ('create' | 'update' | 'delete')[];
}

// Firehose handler types
export type FirehoseEventHandler<T = FirehoseEvent> = (
  event: T,
) => Effect.Effect<void, Error>;

export type CommitHandler = FirehoseEventHandler<
  FirehoseEvent & { commit: RepoCommit }
>;
export type IdentityHandler = FirehoseEventHandler<
  FirehoseEvent & { identity: IdentityEvent }
>;

// Firehose subscription interface
export interface FirehoseSubscription {
  readonly start: () => Effect.Effect<never, Error>;
  readonly stop: () => Effect.Effect<void, Error>;
  readonly isActive: () => boolean;
  readonly getCursor: () => string | undefined;
  readonly setCursor: (cursor: string) => void;
}

// Sync error types
export class FirehoseError extends Error {
  readonly _tag = 'FirehoseError';

  constructor(
    readonly options: {
      readonly cause: unknown;
      readonly operation: 'connect' | 'subscribe' | 'parse' | 'handle';
    },
  ) {
    super(`Firehose operation '${options.operation}' failed: ${options.cause}`);
  }
}

export class SyncError extends Error {
  readonly _tag = 'SyncError';

  constructor(
    readonly options: {
      readonly cause: unknown;
      readonly operation: 'sync' | 'download' | 'parse';
      readonly did?: string;
    },
  ) {
    super(
      `Sync operation '${options.operation}' failed${options.did ? ` for ${options.did}` : ''}: ${options.cause}`,
    );
  }
}
