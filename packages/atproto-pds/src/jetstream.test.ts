import { type AccountEvent, type CommitEvent } from './firehose.js';
import {
  CODEC_DAG_CBOR,
  cidFromDigest,
  encodeCbor,
  formatCid,
} from '@eoa/core';
import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  jetstreamFrames,
  jetstreamQuery,
  jetstreamStream,
} from './jetstream.js';
import { encodeCar } from '@eoa/repo-store';
import { sha256 } from '@eoa/crypto';

const anEvent = async (): Promise<CommitEvent> => {
  const record = { $type: 'app.test.record', n: 1 };
  const bytes = encodeCbor(record as never);
  // The repo's own hash, so the CID here is the CID the store would give it.
  const digest = await Effect.runPromise(sha256(bytes));
  const cid = cidFromDigest({ codec: CODEC_DAG_CBOR, digest });
  return {
    kind: 'commit',
    seq: 1,
    timeUs: 1_700_000_000_000_000,
    time: '2026-10-19T00:00:00.000Z',
    did: 'did:plc:test',
    commit: 'bafyrei-commit',
    rev: '3test',
    since: null,
    ops: [
      { action: 'create', path: 'app.test.record/one', cid: formatCid(cid) },
      // A delete carries no record, so the frame must not invent one.
      { action: 'delete', path: 'app.test.record/two', cid: null },
    ],
    blocks: encodeCar({ roots: [cid], blocks: [{ cid, bytes }] }),
    tooBig: false,
  };
};

describe('a commit as Jetstream frames', () => {
  it('addresses records, and a delete carries none', async () => {
    const frames = await Effect.runPromise(
      jetstreamFrames({ event: await anEvent(), filter: {} }),
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]?.commit).toEqual({
      rev: '3test',
      operation: 'create',
      collection: 'app.test.record',
      rkey: 'one',
      record: { $type: 'app.test.record', n: 1 },
      cid: frames[0]?.commit.cid,
    });
    expect(frames[1]?.commit.operation).toBe('delete');
    expect(frames[1]?.commit.record).toBeUndefined();
    expect(frames[0]?.time_us).toBe(1_700_000_000_000_000);
  });

  it('filters by DID and by collection', async () => {
    const event = await anEvent();
    expect(
      await Effect.runPromise(
        jetstreamFrames({ event, filter: { wantedDids: ['did:plc:other'] } }),
      ),
    ).toEqual([]);
    expect(
      await Effect.runPromise(
        jetstreamFrames({
          event,
          filter: { wantedCollections: ['app.test.other'] },
        }),
      ),
    ).toEqual([]);
  });

  it('reads the query the way a Jetstream client writes it', () => {
    const query = jetstreamQuery(
      new URLSearchParams(
        'cursor=42&wantedCollections=a.b&wantedCollections=c.d',
      ),
    );
    expect(query.cursor).toBe(42);
    expect(query.filter.wantedCollections).toEqual(['a.b', 'c.d']);
    expect(query.filter.wantedDids).toBeUndefined();
    expect(jetstreamQuery(new URLSearchParams()).cursor).toBeUndefined();
  });

  it('reads repeated ?space= as the set it follows', () => {
    const query = jetstreamQuery(
      new URLSearchParams('space=at://a/b/c&space=at://d/e/f'),
    );
    expect(query.spaces).toEqual(['at://a/b/c', 'at://d/e/f']);
    // No `?space=` is the public stream: no set, and nothing to gate.
    expect(jetstreamQuery(new URLSearchParams()).spaces).toBeUndefined();
  });
});

describe('an account event as a Jetstream frame', () => {
  const anAccount = (over: Partial<AccountEvent> = {}): AccountEvent => ({
    kind: 'account',
    seq: 2,
    timeUs: 1_700_000_000_000_001,
    time: '2026-11-07T00:00:00.000Z',
    did: 'did:plc:test',
    active: false,
    status: 'suspended',
    ...over,
  });

  const shapeOf = (events: ReadonlyArray<AccountEvent>) => ({
    subscribe: () => Stream.fromIterable(events),
    subscribeSpaces: () => Stream.empty,
  });

  it('is the frame a consumer hides a member with, not a skipped event', async () => {
    const frames = await Effect.runPromise(
      jetstreamStream({ firehose: shapeOf([anAccount()]), filter: {} }).pipe(
        Stream.runCollect,
      ),
    );

    expect([...frames]).toEqual([
      {
        did: 'did:plc:test',
        time_us: 1_700_000_000_000_001,
        kind: 'account',
        account: { active: false, status: 'suspended' },
      },
    ]);
  });

  it('follows wantedDids, and a collection filter does not drop it', async () => {
    const other = await Effect.runPromise(
      jetstreamStream({
        firehose: shapeOf([anAccount()]),
        filter: { wantedDids: ['did:plc:other'] },
      }).pipe(Stream.runCollect),
    );
    const byCollection = await Effect.runPromise(
      jetstreamStream({
        firehose: shapeOf([anAccount()]),
        filter: { wantedCollections: ['app.test.other'] },
      }).pipe(Stream.runCollect),
    );

    expect([...other]).toEqual([]);
    // A status move is not a record, so the record filters cannot speak for it.
    expect([...byCollection]).toHaveLength(1);
  });
});
