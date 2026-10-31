import {
  CLOCK_ID_LIMIT,
  InvalidTidError,
  TID_LENGTH,
  nextTid,
  tidClockId,
  tidFromTime,
  tidTimestamp,
} from './tid.js';
import { CODEC_DAG_CBOR, cidFromDigest, formatCid } from '@eoa/core';
import { commitCid, decodeCommit, signCommit, verifyCommit } from './commit.js';
import { describe, expect, it } from 'vitest';
import { generateES256KeyPair, sha256 } from '@eoa/crypto';
import { Effect } from 'effect';
import { readCar } from './car.js';
import { readFileSync } from 'node:fs';

const fixture = new Uint8Array(
  readFileSync(new URL('../fixtures/repo-sample.car', import.meta.url)),
);

/** The real commit, and the CID the fixture files it under. */
const fixtureCommit = async () => {
  const car = await Effect.runPromise(readCar(fixture));
  const [root] = car.roots;
  const block =
    root === undefined ? undefined : car.blocks.get(formatCid(root));
  return {
    root,
    commit: block === undefined ? undefined : decodeCommit(block.bytes),
  };
};

/** A CID for tests that need a well-formed value but not a particular one. */
const someCid = () =>
  Effect.gen(function* () {
    const digest = yield* sha256(new Uint8Array([1, 2, 3]));
    return cidFromDigest({ codec: CODEC_DAG_CBOR, digest });
  });

/** Microseconds, so a fixed clock is a fixed timestamp. */
const NOW = 1_760_000_000_000;

describe('TIDs', () => {
  it('is thirteen sortable base32 characters', () => {
    const tid = tidFromTime({ timestamp: 1_234_567_890_123, clockId: 5 });

    expect(tid).toHaveLength(TID_LENGTH);
    expect(tid).toMatch(/^[234567a-z]{13}$/);
    // Sortable: the older one is the smaller string, which is the whole point.
    expect(
      tid < tidFromTime({ timestamp: 1_234_567_890_124, clockId: 5 }),
    ).toBe(true);
  });

  it('round-trips the timestamp and the clock id', () => {
    const tid = tidFromTime({ timestamp: 1_760_000_000_000_000, clockId: 17 });

    expect(tidTimestamp(tid)).toBe(1_760_000_000_000_000);
    expect(tidClockId(tid)).toBe(17);
  });

  it("decodes the real commit's rev to a plausible time", async () => {
    const { commit } = await fixtureCommit();
    expect(commit).toBeDefined();
    if (commit === undefined) {
      return;
    }

    // The layout is the claim: eleven digits of microseconds. A rev from a real
    // repository has to land in a window we already know, which makes this a
    // check of the encoding rather than of our own arithmetic.
    const asMillis = tidTimestamp(commit.rev) / 1000;
    expect(asMillis).toBeGreaterThan(Date.UTC(2023, 0, 1));
    expect(asMillis).toBeLessThan(Date.UTC(2027, 0, 1));
    expect(tidClockId(commit.rev)).toBeLessThan(CLOCK_ID_LIMIT);
  });

  it('never goes backwards, even when the clock does not', () => {
    const first = nextTid({ previous: undefined, now: NOW, clockId: 3 });
    const second = nextTid({ previous: first, now: NOW, clockId: 3 });
    const afterABackwardsClock = nextTid({
      previous: second,
      now: NOW - 5_000,
      clockId: 3,
    });

    expect(second > first).toBe(true);
    expect(afterABackwardsClock > second).toBe(true);
  });

  it('refuses what cannot be a TID', () => {
    expect(() => tidFromTime({ timestamp: -1, clockId: 0 })).toThrow(
      InvalidTidError,
    );
    expect(() =>
      tidFromTime({ timestamp: 0, clockId: CLOCK_ID_LIMIT }),
    ).toThrow(InvalidTidError);
    expect(() => tidFromTime({ timestamp: 2 ** 70, clockId: 0 })).toThrow(
      InvalidTidError,
    );
  });
});

describe('commits', () => {
  it('accepts a real commit, and reproduces its CID', async () => {
    const { commit, root } = await fixtureCommit();
    expect(commit).toBeDefined();
    expect(root).toBeDefined();
    if (commit === undefined || root === undefined) {
      return;
    }

    // Our schema has to read what a real PDS wrote, and our encoding has to
    // hash to the CID the real CAR files it under - including `sig` as a byte
    // string rather than base64url text.
    expect(commit.version).toBe(3);
    expect(commit.sig).toHaveLength(64);
    expect(commit.prev).toBeNull();
    expect(formatCid(await Effect.runPromise(commitCid(commit)))).toBe(
      formatCid(root),
    );
  });

  it('does not accept a foreign signature as its own', async () => {
    const { commit } = await fixtureCommit();
    const keys = await Effect.runPromise(generateES256KeyPair());
    expect(commit).toBeDefined();
    if (commit === undefined) {
      return;
    }

    // The real account signs with secp256k1, which we do not import yet (M6),
    // so a P-256 check must answer "no" rather than "yes". Silence here would
    // be the dangerous answer, and this test is what keeps it an answer.
    expect(
      await Effect.runPromise(verifyCommit({ commit, key: keys.publicKey })),
    ).toBe(false);
  });

  it('signs a commit it can verify, and has it cover every other field', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const data = await Effect.runPromise(someCid());
    const commit = await Effect.runPromise(
      signCommit({
        did: 'did:plc:ourselves',
        data,
        rev: nextTid({ previous: undefined, now: NOW, clockId: 1 }),
        previous: undefined,
        key: keys.privateKey,
      }),
    );

    expect(commit.did).toBe('did:plc:ourselves');
    expect(commit.version).toBe(3);
    expect(commit.prev).toBeNull();
    expect(
      await Effect.runPromise(verifyCommit({ commit, key: keys.publicKey })),
    ).toBe(true);

    // An unsigned field is inside the signature: editing it has to invalidate,
    // or a commit would not be a commitment to its own contents.
    const tampered = { ...commit, did: 'did:plc:someone-else' };
    expect(
      await Effect.runPromise(
        verifyCommit({ commit: tampered, key: keys.publicKey }),
      ),
    ).toBe(false);
  });

  it('chains: prev is the CID of the commit before it', async () => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const data = await Effect.runPromise(someCid());
    const first = await Effect.runPromise(
      signCommit({
        did: 'did:plc:chain',
        data,
        rev: nextTid({ previous: undefined, now: NOW, clockId: 2 }),
        previous: undefined,
        key: keys.privateKey,
      }),
    );
    const firstCid = await Effect.runPromise(commitCid(first));
    const second = await Effect.runPromise(
      signCommit({
        did: 'did:plc:chain',
        data,
        rev: nextTid({ previous: first.rev, now: NOW, clockId: 2 }),
        previous: firstCid,
        key: keys.privateKey,
      }),
    );

    expect(second.prev?.cid).toEqual(firstCid);
    expect(second.rev > first.rev).toBe(true);
    expect(second.data.cid).toEqual(first.data.cid);
  });
});
