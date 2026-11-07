import { describe, expect, it } from 'vitest';
import type { DID } from '@eoa/core';
import { SyncError } from './types.js';

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
