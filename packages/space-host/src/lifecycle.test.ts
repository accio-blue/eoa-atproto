import { ALICE, BOB, RUNS, SPACE, cid, op, rkey, tid } from './fixtures.js';
import {
  BadRecordSwapError,
  SpaceWriteLog,
  StaleEpochError,
  WriteLock,
} from './write-log.js';
import { Effect, Layer } from 'effect';
import { WriterSet, clearRecords, removeWriter } from './lifecycle.js';
import { describe, expect, it } from 'vitest';
import { ltHashDigestOf } from './lthash.js';

/**
 * The two 2026-10-29 lifecycle methods. Both tests fail if the method silently
 * does nothing: the clear would leave records behind, the prune would leave the
 * writer listed.
 */

const layer = WriterSet.layerInMemory.pipe(
  Layer.provideMerge(
    SpaceWriteLog.layerInMemory.pipe(
      Layer.provideMerge(WriteLock.layerInMemory),
    ),
  ),
);

const run = <A, E>(
  program: Effect.Effect<A, E, WriterSet | SpaceWriteLog | WriteLock>,
) => Effect.runPromise(program.pipe(Effect.provide(layer)));

const REPO = { space: SPACE, did: ALICE };

const CLEAR_REV = tid('bbbbbbbbbbbbb');

const bobEntry = {
  space: SPACE,
  did: BOB,
  rev: tid('aaaaaaaaaaaaa'),
  data: new Uint8Array([1, 2, 3]),
};

describe('clearRecords: one entry empties the repo', () => {
  it('leaves the repo empty at the empty digest, not one delete per record', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* SpaceWriteLog;
        const lock = yield* WriteLock;
        const epoch = yield* lock.acquire(SPACE);
        yield* log.append(REPO, op({ cid: cid('bafy1') }), {
          base: null,
          epoch,
        });
        yield* log.append(REPO, op({ rkey: rkey('r2'), cid: cid('bafy2') }), {
          base: cid('bafy1'),
          epoch,
        });
        const before = [...(yield* log.state(REPO)).keys()];
        const seq = yield* clearRecords({
          space: SPACE,
          did: ALICE,
          rev: CLEAR_REV,
          author: ALICE,
          signature: new Uint8Array([9]),
          commit: { base: cid('bafy2'), epoch },
        });
        const entries = yield* log.entries(REPO);
        const last = entries.at(-1);
        return {
          before,
          seq,
          count: entries.length,
          action: last?.action,
          data: last?.action === 'clear' ? last.data : undefined,
          rev: last?.rev,
          state: yield* log.state(REPO),
          head: yield* log.head(REPO),
          emptyDigest: yield* ltHashDigestOf([]),
        };
      }),
    );
    expect(result.before).toEqual([`${RUNS}/r1`, `${RUNS}/r2`]);
    // Two records plus ONE clear entry: not a delete per record.
    expect(result.count).toBe(3);
    expect(result.seq).toBe(3);
    expect(result.action).toBe('clear');
    expect(result.rev).toBe(CLEAR_REV);
    // The digest a syncer is told about is the empty repo's.
    expect(result.data).toEqual(result.emptyDigest);
    expect([...result.state.keys()]).toEqual([]);
    expect(result.head).toBe(null);
  });

  it('refuses a clear on a head the caller did not see, leaving the records', async () => {
    const result = await run(
      Effect.gen(function* () {
        const log = yield* SpaceWriteLog;
        const lock = yield* WriteLock;
        const epoch = yield* lock.acquire(SPACE);
        yield* log.append(REPO, op({ cid: cid('bafy1') }), {
          base: null,
          epoch,
        });
        const conflict = yield* clearRecords({
          space: SPACE,
          did: ALICE,
          rev: CLEAR_REV,
          author: ALICE,
          signature: new Uint8Array([9]),
          commit: { base: null, epoch },
        }).pipe(Effect.flip);
        return { conflict, state: yield* log.state(REPO) };
      }),
    );
    expect(result.conflict).toBeInstanceOf(BadRecordSwapError);
    expect([...result.state.keys()]).toEqual([`${RUNS}/r1`]);
  });
});

describe('removeWriter: prune under the fence', () => {
  it('drops the account from the writer set, idempotently', async () => {
    const result = await run(
      Effect.gen(function* () {
        const writers = yield* WriterSet;
        const lock = yield* WriteLock;
        const epoch = yield* lock.acquire(SPACE);
        yield* writers.track(bobEntry);
        const before = yield* writers.list(SPACE);
        const dropped = yield* removeWriter({
          space: SPACE,
          did: BOB,
          epoch,
        });
        const again = yield* removeWriter({ space: SPACE, did: BOB, epoch });
        return { before, dropped, again, after: yield* writers.list(SPACE) };
      }),
    );
    expect(result.before).toHaveLength(1);
    expect(result.dropped).toBe(true);
    expect(result.again).toBe(false);
    expect(result.after).toEqual([]);
  });

  it('rejects a stale epoch, so an older removal cannot prune', async () => {
    const result = await run(
      Effect.gen(function* () {
        const writers = yield* WriterSet;
        const lock = yield* WriteLock;
        const epoch = yield* lock.acquire(SPACE);
        yield* writers.track(bobEntry);
        yield* lock.acquire(SPACE);
        const stale = yield* removeWriter({
          space: SPACE,
          did: BOB,
          epoch,
        }).pipe(Effect.flip);
        return { stale, after: yield* writers.list(SPACE) };
      }),
    );
    expect(result.stale).toBeInstanceOf(StaleEpochError);
    expect(result.after).toHaveLength(1);
  });

  it('an in-flight write cannot resurrect the entry; a later authorized write can', async () => {
    const result = await run(
      Effect.gen(function* () {
        const writers = yield* WriterSet;
        const log = yield* SpaceWriteLog;
        const lock = yield* WriteLock;
        const inFlight = yield* lock.acquire(SPACE);
        yield* writers.track(bobEntry);
        const removal = yield* lock.acquire(SPACE);
        yield* removeWriter({ space: SPACE, did: BOB, epoch: removal });
        const stale = yield* log
          .append(REPO, op({ cid: cid('bafy1') }), {
            base: null,
            epoch: inFlight,
          })
          .pipe(Effect.flip);
        const fresh = yield* lock.acquire(SPACE);
        yield* log.append(REPO, op({ cid: cid('bafy1') }), {
          base: null,
          epoch: fresh,
        });
        yield* writers.track(bobEntry);
        return { stale, after: yield* writers.list(SPACE) };
      }),
    );
    expect(result.stale).toBeInstanceOf(StaleEpochError);
    expect(result.after).toHaveLength(1);
  });
});
