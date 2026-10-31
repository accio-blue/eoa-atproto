import { FirehoseError, SyncError } from './types.js';
import { describe, expect, it } from 'vitest';
import type { DID } from '@eoa/core';

describe('FirehoseError', () => {
  it('formats the failed operation into the message', () => {
    const error = new FirehoseError({
      cause: 'timed out',
      operation: 'connect',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe('FirehoseError');
    expect(error.message).toBe(
      "Firehose operation 'connect' failed: timed out",
    );
    expect(error.options).toEqual({
      cause: 'timed out',
      operation: 'connect',
    });
  });

  it('preserves the original cause', () => {
    const cause = new Error('socket closed');
    const error = new FirehoseError({ cause, operation: 'subscribe' });

    expect(error.options.cause).toBe(cause);
    expect(error.message).toContain('socket closed');
  });
});

describe('SyncError', () => {
  it('includes the did when one is supplied', () => {
    const did = 'did:plc:test' as DID;
    const error = new SyncError({
      cause: 'bad head',
      operation: 'sync',
      did,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe('SyncError');
    expect(error.message).toBe(
      `Sync operation 'sync' failed for ${did}: bad head`,
    );
    expect(error.options.did).toBe(did);
  });

  it('omits the did when it is absent', () => {
    const error = new SyncError({
      cause: 'download failed',
      operation: 'download',
    });

    expect(error.message).toBe(
      "Sync operation 'download' failed: download failed",
    );
    expect(error.options.did).toBeUndefined();
  });
});
