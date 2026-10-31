import { ALICE, AUTHORITY, cid, op as opFixture, tid } from './fixtures.js';
import {
  AuthorKeys,
  ingestFailure,
  opSigningBytes,
  revIsMonotonic,
  verifyOpSignature,
} from './ingest.js';
import {
  type KeyPair,
  type PublicKey,
  generateES256KeyPair,
  sign,
} from '@eoa/crypto';
import type { RecordHead, SpaceRecordOp } from './write-log.js';
import { describe, expect, it } from 'vitest';
import { type DID } from '@eoa/core';
import { Effect } from 'effect';

const run = Effect.runPromise;
const EARLIER = tid('aaaaaaaaaaaaa');
const LATER = tid('bbbbbbbbbbbbb');

const signedOp = (pair: KeyPair, overrides: Partial<SpaceRecordOp> = {}) =>
  Effect.gen(function* () {
    const op = opFixture({
      author: AUTHORITY,
      cid: cid('bafy1'),
      rev: LATER,
      ...overrides,
    });
    const signature = yield* sign(pair.privateKey, opSigningBytes(op));
    return { ...op, signature };
  });

const check = (
  op: SpaceRecordOp,
  keys: ReadonlyMap<DID, PublicKey>,
  current?: RecordHead,
) =>
  ingestFailure({ op, authority: AUTHORITY, current }).pipe(
    Effect.provide(AuthorKeys.layerFrom(keys)),
    Effect.runPromise,
  );

describe('op ingest', () => {
  it('accepts a signed op from the space authority with a forward revision', async () => {
    const pair = await run(generateES256KeyPair());
    const keys = new Map([[AUTHORITY, pair.publicKey]]);
    const op = await run(signedOp(pair));
    expect(await check(op, keys)).toBe(undefined);
  });

  it('rejects a tampered op', async () => {
    const pair = await run(generateES256KeyPair());
    const keys = new Map([[AUTHORITY, pair.publicKey]]);
    const op = await run(signedOp(pair));
    expect(await check({ ...op, cid: cid('bafytampered') }, keys)).toBe(
      'bad-signature',
    );
  });

  it('rejects an op signed by another key', async () => {
    const author = await run(generateES256KeyPair());
    const other = await run(generateES256KeyPair());
    const keys = new Map([[AUTHORITY, other.publicKey]]);
    const op = await run(signedOp(author));
    expect(await check(op, keys)).toBe('bad-signature');
  });

  it('rejects an author that is not the space authority', async () => {
    const pair = await run(generateES256KeyPair());
    const keys = new Map([[AUTHORITY, pair.publicKey]]);
    const op = await run(signedOp(pair, { author: ALICE }));
    expect(await check(op, keys)).toBe('not-authority');
  });

  it('rejects a revision that does not move forward', async () => {
    const pair = await run(generateES256KeyPair());
    const keys = new Map([[AUTHORITY, pair.publicKey]]);
    const op = await run(signedOp(pair, { rev: EARLIER }));
    const current: RecordHead = {
      cid: cid('bafycurrent'),
      rev: LATER,
      author: AUTHORITY,
      value: undefined,
    };
    expect(await check(op, keys, current)).toBe('rev-not-monotonic');
  });

  it('compares revisions as sortable ids', () => {
    expect(revIsMonotonic({ rev: LATER }, undefined)).toBe(true);
    expect(
      revIsMonotonic(
        { rev: EARLIER },
        { cid: cid('bafy'), rev: LATER, author: AUTHORITY, value: undefined },
      ),
    ).toBe(false);
    expect(
      revIsMonotonic(
        { rev: LATER },
        { cid: cid('bafy'), rev: EARLIER, author: AUTHORITY, value: undefined },
      ),
    ).toBe(true);
  });

  it('verifies a signature against the author key directly', async () => {
    const pair = await run(generateES256KeyPair());
    const op = await run(signedOp(pair));
    expect(await run(verifyOpSignature(op, pair.publicKey))).toBe(true);
  });
});
