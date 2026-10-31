import { type Cid, formatCid } from '@eoa/core';
import { commitCid, decodeCommit, signCommit, verifyCommit } from './commit.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { generateES256KeyPair } from '@eoa/crypto';
import { readFixture } from './fixture.js';

const { roots, blocks } = readFixture();

const firstRoot = roots[0];
if (firstRoot === undefined) {
  throw new Error('the fixture CAR has no root');
}

const blockFor = (cid: Cid) => {
  const block = blocks.get(formatCid(cid));
  if (block === undefined) {
    throw new Error(`the fixture has no block for ${formatCid(cid)}`);
  }
  return block;
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('the repo commit', () => {
  it('re-encodes a captured commit to the CID the CAR is rooted at', async () => {
    const captured = decodeCommit(blockFor(firstRoot).bytes);
    const again = await run(commitCid(captured));

    expect(formatCid(again)).toBe(formatCid(firstRoot));
    expect(captured.version).toBe(3);
    expect(captured.sig.length).toBeGreaterThan(0);
    expect(captured.prev).toBeNull();
  });

  it('signs a commit so that it verifies, and chains it to the one before', async () => {
    const captured = decodeCommit(blockFor(firstRoot).bytes);

    const result = await run(
      Effect.gen(function* () {
        const keys = yield* generateES256KeyPair();
        const commit = yield* signCommit({
          did: captured.did,
          data: captured.data.cid,
          rev: captured.rev,
          previous: firstRoot,
          key: keys.privateKey,
        });
        return {
          ok: yield* verifyCommit({ commit, key: keys.publicKey }),
          cid: yield* commitCid(commit),
          prev: commit.prev?.cid,
        };
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.prev).toEqual(firstRoot);
    expect(formatCid(result.cid)).not.toBe(formatCid(firstRoot));
  });

  it('rejects a commit that is not one', () => {
    expect(() => decodeCommit(blockFor(firstRoot).bytes.slice(0, 4))).toThrow();
  });
});
