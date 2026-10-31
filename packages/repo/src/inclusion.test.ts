import {
  InclusionError,
  ReleaseMismatchError,
  verifyRecordInclusion,
  verifyRelease,
} from './inclusion.js';
import { base64urlEncode, generateES256KeyPair, sha256 } from '@eoa/crypto';
import { carOf, createRepo, putRecord, recordCid } from './repo.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { formatCid } from '@eoa/core';

const PUBLISHER = 'did:plc:publisher';
const RELEASE = 'ing.lexicon.plugin.release';
const RKEY = 'self';
const NOW = 1_760_000_000_000;

/** A signed repo holding one release record, its CAR, and the record's CID. */
const build = () =>
  Effect.gen(function* () {
    const keys = yield* generateES256KeyPair();
    const repo = yield* createRepo({
      did: PUBLISHER,
      key: keys.privateKey,
      clockId: 3,
      now: NOW,
    });
    const written = yield* putRecord({
      repo,
      collection: RELEASE,
      rkey: RKEY,
      record: { $type: RELEASE, version: '1.0.0' },
      key: keys.privateKey,
      now: NOW,
    });
    const cid = recordCid({ repo: written, collection: RELEASE, rkey: RKEY });
    const car = yield* carOf(written);
    return { keys, car, cid };
  });

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('verifyRecordInclusion', () => {
  it('proves a record is in the publisher-signed repo', async () => {
    const { keys, car, cid } = await run(build());
    expect(cid).toBeDefined();
    if (cid === undefined) {
      return;
    }

    const result = await run(
      verifyRecordInclusion({
        car,
        key: keys.publicKey,
        collection: RELEASE,
        rkey: RKEY,
        cid: formatCid(cid),
      }),
    );
    expect(result.cid).toBe(formatCid(cid));
  });

  it('refuses a commit signed by a different key', async () => {
    const { car, cid } = await run(build());
    const intruder = await run(generateES256KeyPair());
    if (cid === undefined) {
      return;
    }

    const error = await run(
      Effect.flip(
        verifyRecordInclusion({
          car,
          key: intruder.publicKey,
          collection: RELEASE,
          rkey: RKEY,
          cid: formatCid(cid),
        }),
      ),
    );
    expect(error).toBeInstanceOf(InclusionError);
  });

  it('refuses a record that hashes to a different CID', async () => {
    const { keys, car, cid } = await run(build());
    if (cid === undefined) {
      return;
    }

    const error = await run(
      Effect.flip(
        verifyRecordInclusion({
          car,
          key: keys.publicKey,
          collection: RELEASE,
          rkey: RKEY,
          cid: `${formatCid(cid)}x`,
        }),
      ),
    );
    expect(error).toBeInstanceOf(InclusionError);
    if (error instanceof InclusionError) {
      expect(error.message).toContain('not the declared');
    }
  });

  it('refuses a key the signed commit does not hold', async () => {
    const { keys, car } = await run(build());

    const error = await run(
      Effect.flip(
        verifyRecordInclusion({
          car,
          key: keys.publicKey,
          collection: RELEASE,
          rkey: 'absent',
          cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      ),
    );
    expect(error).toBeInstanceOf(InclusionError);
  });
});

const checksumOf = async (bytes: Uint8Array) =>
  base64urlEncode(await Effect.runPromise(sha256(bytes)));

describe('verifyRelease', () => {
  const BUNDLE = new TextEncoder().encode('a plugin bundle');

  it('proves the record and the artifact together', async () => {
    const { keys, car, cid } = await run(build());
    if (cid === undefined) {
      return;
    }
    const artifact = { sha256: await checksumOf(BUNDLE), size: BUNDLE.length };

    const result = await run(
      verifyRelease({
        car,
        key: keys.publicKey,
        collection: RELEASE,
        rkey: RKEY,
        cid: formatCid(cid),
        artifact,
        bytes: BUNDLE,
      }),
    );

    expect(result.cid).toBe(formatCid(cid));
    expect(result.sha256).toBe(artifact.sha256);
  });

  it('refuses an artifact that does not match its checksum', async () => {
    const { keys, car, cid } = await run(build());
    if (cid === undefined) {
      return;
    }

    const error = await run(
      Effect.flip(
        verifyRelease({
          car,
          key: keys.publicKey,
          collection: RELEASE,
          rkey: RKEY,
          cid: formatCid(cid),
          artifact: { sha256: 'not-the-checksum' },
          bytes: BUNDLE,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ReleaseMismatchError);
  });

  it('refuses an artifact whose declared size disagrees', async () => {
    const { keys, car, cid } = await run(build());
    if (cid === undefined) {
      return;
    }

    const error = await run(
      Effect.flip(
        verifyRelease({
          car,
          key: keys.publicKey,
          collection: RELEASE,
          rkey: RKEY,
          cid: formatCid(cid),
          artifact: {
            sha256: await checksumOf(BUNDLE),
            size: BUNDLE.length + 1,
          },
          bytes: BUNDLE,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ReleaseMismatchError);
  });
});
