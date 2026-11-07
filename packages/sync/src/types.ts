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
