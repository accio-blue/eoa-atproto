import { createDIDKey, generateES256KeyPair } from '@eoa/crypto';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { mintIdentity } from './identity-mint.js';
import { validateGenesisOperation } from '@eoa/identity';

const keys = () =>
  Effect.runPromise(
    Effect.all({
      signing: generateES256KeyPair(),
      rotation: generateES256KeyPair(),
    }),
  );

describe("minting the org's own did:plc", () => {
  it('mints a DID the operation actually names', async () => {
    const pair = await keys();
    const minted = await Effect.runPromise(
      mintIdentity({
        handle: 'alice.pds.example',
        endpoint: 'https://pds.example',
        signingKey: pair.signing.privateKey,
        rotationKey: pair.rotation.privateKey,
      }),
    );

    expect(minted.did).toMatch(/^did:plc:[a-z2-7]{24}$/u);

    // The DID is the hash of the signed genesis operation, so a directory that
    // replays it must name the same identifier — which is what this checks.
    await Effect.runPromise(
      validateGenesisOperation({
        did: minted.did,
        operation: minted.operation,
      }),
    );

    const rotation = await Effect.runPromise(
      createDIDKey(pair.rotation.privateKey.publicKey),
    );
    expect(minted.operation.type).toBe('plc_operation');
    if (minted.operation.type !== 'plc_operation') {
      throw new Error('the genesis operation is not a plc_operation');
    }
    expect(minted.operation.rotationKeys).toEqual([rotation]);
    expect(minted.operation.services.atproto_pds.endpoint).toBe(
      'https://pds.example',
    );
    expect(minted.operation.alsoKnownAs).toEqual(['at://alice.pds.example']);
    expect(minted.operation.sig).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
});
