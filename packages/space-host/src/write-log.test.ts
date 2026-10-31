import {
  ALICE,
  BOB,
  NOTES,
  NOW,
  RUNS,
  SPACE,
  cid,
  grantRef,
  op,
  rkey,
  stored,
  tid,
} from './fixtures.js';
import {
  BadRecordSwapError,
  SpaceWriteLog,
  StaleEpochError,
  WriteLock,
  decodeSpaceRecordOp,
  foldState,
  recordPath,
} from './write-log.js';
import {
  Decision,
  GrantStore,
  LensRegistry,
  Membership,
  checkAccess,
} from './evaluate.js';
import { Effect, Layer, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { RevocationLog } from './revocation.js';
import { aturi } from './fixtures.js';

// Mirrors packages/specs/specs/space-host/{space-write-log,grant-lifecycle}.qnt.

const logLayer = SpaceWriteLog.layerInMemory.pipe(
  Layer.provideMerge(WriteLock.layerInMemory),
);

const REPO = { space: SPACE, did: ALICE };

const OTHER = aturi('at://did:plc:authority/ing.lexicon.space/other');

const run = <A, E>(program: Effect.Effect<A, E, SpaceWriteLog | WriteLock>) =>
  Effect.runPromise(program.pipe(Effect.provide(logLayer)));

/** Acquire the writer epoch and return a `write(op, base)` bound to it. */
const writer = Effect.gen(function* () {
  const log = yield* SpaceWriteLog;
  const lock = yield* WriteLock;
  const epoch = yield* lock.acquire(SPACE);
  return {
    log,
    lock,
    epoch,
    write: (next: ReturnType<typeof op>, base: ReturnType<typeof cid> | null) =>
      log.append(REPO, next, { base, epoch }),
  };
});

describe('space write log: append-only CAS', () => {
  it('starts empty and a commit advances the head by one', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, write } = yield* writer;
        const empty = yield* log.head(REPO);
        const seq = yield* write(op({ cid: cid('bafy1') }), null);
        return { empty, seq, head: yield* log.head(REPO) };
      }),
    );
    expect(result).toEqual({ empty: null, seq: 1, head: 'bafy1' });
  });

  it('a stale base conflicts and leaves the log untouched (never merges)', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, write } = yield* writer;
        yield* write(op({ cid: cid('bafy1') }), null);
        const before = yield* log.entries(REPO);
        const conflict = yield* write(
          op({ rkey: rkey('r2'), cid: cid('bafy2') }),
          null,
        ).pipe(Effect.flip);
        return { before, conflict, after: yield* log.entries(REPO) };
      }),
    );
    expect(result.conflict).toBeInstanceOf(BadRecordSwapError);
    expect(result.conflict).toMatchObject({
      scope: 'head',
      expected: null,
      actual: 'bafy1',
    });
    expect(result.after).toEqual(result.before);
    expect(result.after).toHaveLength(1);
  });

  it('spec race: a competing writer moves the head, the stale append fails, a re-read retry commits', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, write } = yield* writer;
        const base = yield* log.head(REPO); // begin
        yield* write(op({ cid: cid('bafyrival') }), base); // race
        const stale = yield* write(
          op({ rkey: rkey('r2'), cid: cid('bafy2') }),
          base,
        ).pipe(Effect.flip);
        const fresh = yield* log.head(REPO); // re-read
        const seq = yield* write(
          op({ rkey: rkey('r2'), cid: cid('bafy2') }),
          fresh,
        );
        return { stale, seq, head: yield* log.head(REPO) };
      }),
    );
    expect(result.stale).toBeInstanceOf(BadRecordSwapError);
    expect(result.seq).toBe(2);
    expect(result.head).toBe('bafy2');
  });

  it('two writers racing on the same base: exactly one commits', async () => {
    const outcomes = await run(
      Effect.gen(function* () {
        const { log, write } = yield* writer;
        const base = yield* log.head(REPO);
        const results = yield* Effect.all(
          [
            write(op({ rkey: rkey('a'), cid: cid('bafya') }), base),
            write(op({ rkey: rkey('b'), cid: cid('bafyb') }), base),
          ],
          { concurrency: 'unbounded', mode: 'result' },
        );
        return { results, size: (yield* log.entries(REPO)).length };
      }),
    );
    expect(outcomes.results.filter((r) => r._tag === 'Success')).toHaveLength(
      1,
    );
    expect(outcomes.size).toBe(1);
  });

  it('the record CAS: prevCid must match the current record', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, write } = yield* writer;
        yield* write(op({ cid: cid('bafy1') }), null);
        const wrongPrev = yield* write(
          op({ action: 'update', prevCid: cid('nope'), cid: cid('bafy2') }),
          cid('bafy1'),
        ).pipe(Effect.flip);
        const createOverExisting = yield* write(
          op({ cid: cid('bafy3') }),
          cid('bafy1'),
        ).pipe(Effect.flip);
        const deleteMissing = yield* write(
          op({
            rkey: rkey('ghost'),
            action: 'delete',
            prevCid: cid('bafy1'),
            cid: cid('bafy4'),
          }),
          cid('bafy1'),
        ).pipe(Effect.flip);
        return {
          wrongPrev,
          createOverExisting,
          deleteMissing,
          size: (yield* log.entries(REPO)).length,
        };
      }),
    );
    expect(result.wrongPrev).toMatchObject({
      scope: 'record',
      expected: 'nope',
      actual: 'bafy1',
    });
    expect(result.createOverExisting).toMatchObject({
      scope: 'record',
      expected: null,
      actual: 'bafy1',
    });
    expect(result.deleteMissing).toMatchObject({
      scope: 'record',
      actual: null,
    });
    expect(result.size).toBe(1);
  });

  it('a batch commits every op or none of them', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, epoch } = yield* writer;
        yield* log.append(REPO, op({ cid: cid('bafy1') }), {
          base: null,
          epoch,
        });
        // The second op re-creates a path the first already made: the whole
        // batch is refused, not just its tail.
        const refused = yield* log
          .appendBatch(
            REPO,
            [
              op({ rkey: rkey('b'), cid: cid('bafyb') }),
              op({ rkey: rkey('b'), cid: cid('bafyb2') }),
            ],
            { base: cid('bafy1'), epoch },
          )
          .pipe(Effect.result);
        const afterRefusal = yield* log.entries(REPO);
        const committed = yield* log.appendBatch(
          REPO,
          [
            op({ rkey: rkey('b'), cid: cid('bafyb') }),
            op({ rkey: rkey('c'), cid: cid('bafyc') }),
          ],
          { base: cid('bafy1'), epoch },
        );
        return {
          refused,
          afterRefusal,
          committed,
          state: yield* log.state(REPO),
        };
      }),
    );
    expect(Result.isFailure(result.refused)).toBe(true);
    expect(result.afterRefusal).toHaveLength(1);
    expect(result.committed).toBe(3);
    expect([...result.state.keys()]).toEqual([
      `${RUNS}/r1`,
      `${RUNS}/b`,
      `${RUNS}/c`,
    ]);
  });

  it('one space holds an independent log per account', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, lock } = yield* writer;
        const other = { space: SPACE, did: BOB };
        const bobEpoch = yield* lock.acquire(SPACE);
        yield* log.append(REPO, op({ cid: cid('bafyalice') }), {
          base: null,
          epoch: bobEpoch,
        });
        yield* log.append(
          other,
          { ...op({ cid: cid('bafybob') }), author: BOB },
          {
            base: null,
            epoch: bobEpoch,
          },
        );
        return {
          alice: yield* log.head(REPO),
          bob: yield* log.head(other),
        };
      }),
    );
    expect(result).toEqual({ alice: 'bafyalice', bob: 'bafybob' });
  });

  it('the current state is a fold over the log', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, write } = yield* writer;
        yield* write(op({ cid: cid('bafy1') }), null);
        yield* write(
          op({
            rkey: rkey('r2'),
            cid: cid('bafy2'),
            rev: tid('aaaaaaaaaaaab'),
          }),
          cid('bafy1'),
        );
        yield* write(
          op({
            action: 'update',
            prevCid: cid('bafy1'),
            cid: cid('bafy3'),
            rev: tid('aaaaaaaaaaaac'),
          }),
          cid('bafy2'),
        );
        yield* write(
          op({
            rkey: rkey('r2'),
            action: 'delete',
            prevCid: cid('bafy2'),
            cid: cid('bafy4'),
            rev: tid('aaaaaaaaaaaad'),
          }),
          cid('bafy3'),
        );
        return {
          state: yield* log.state(REPO),
          log: yield* log.entries(REPO),
        };
      }),
    );
    expect([...result.state.keys()]).toEqual([`${RUNS}/r1`]);
    expect(result.state.get(`${RUNS}/r1`)).toMatchObject({ cid: 'bafy3' });
    expect(result.log).toHaveLength(4);
    expect(foldState(result.log)).toEqual(result.state);
  });

  it('exposes no mutation: the log only grows, even when it is cleared', async () => {
    const methods = await run(
      Effect.gen(function* () {
        const log = yield* SpaceWriteLog;
        return Object.keys(log).sort();
      }),
    );
    expect(methods).toEqual([
      'append',
      'appendBatch',
      'clear',
      'entries',
      'head',
      'repos',
      'state',
    ]);
  });

  it('spaces are independent logs', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, write } = yield* writer;
        yield* write(op({ cid: cid('bafy1') }), null);
        return yield* log.head(REPO);
      }),
    );
    expect(result).toBe('bafy1');
  });
});

describe('space write log: fencing epoch seam', () => {
  it('a stale writer epoch is rejected and cannot write', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, lock, epoch } = yield* writer;
        const takeover = yield* lock.acquire(SPACE);
        const stale = yield* log
          .append(REPO, op({ cid: cid('bafy1') }), { base: null, epoch })
          .pipe(Effect.flip);
        const ok = yield* log.append(REPO, op({ cid: cid('bafy1') }), {
          base: null,
          epoch: takeover,
        });
        return { stale, ok, epoch, takeover };
      }),
    );
    expect(result.stale).toBeInstanceOf(StaleEpochError);
    expect(result.stale).toMatchObject({
      presented: result.epoch,
      current: result.takeover,
    });
    expect(result.ok).toBe(1);
  });

  it('a stale epoch leaves the log untouched', async () => {
    const entries = await run(
      Effect.gen(function* () {
        const { log, lock, epoch } = yield* writer;
        yield* lock.acquire(SPACE);
        yield* log
          .append(REPO, op({ cid: cid('bafy1') }), { base: null, epoch })
          .pipe(Effect.ignore);
        return yield* log.entries(REPO);
      }),
    );
    expect(entries).toEqual([]);
  });
});

describe('space record op schema', () => {
  const wire = {
    space: SPACE,
    collection: RUNS,
    rkey: 'r1',
    action: 'create',
    cid: 'bafy1',
    rev: 'aaaaaaaaaaaaa',
    author: ALICE,
    signature: new Uint8Array([1]),
  };

  it('decodes a well-formed op', async () => {
    const decoded = await Effect.runPromise(decodeSpaceRecordOp(wire));
    expect(recordPath(decoded)).toBe(`${RUNS}/r1`);
  });

  it('refuses an unknown action, a bad rev, or stray fields', async () => {
    for (const bad of [
      { ...wire, action: 'merge' },
      { ...wire, rev: 'not-a-tid' },
      { ...wire, mergeWith: 'bafy0' },
    ]) {
      const result = await Effect.runPromise(
        decodeSpaceRecordOp(bad).pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
    }
  });
});

describe('grant lifecycle + CAS fail-closed (grant-lifecycle.qnt)', () => {
  const policy = (grants: Parameters<typeof GrantStore.layerInMemory>[0]) =>
    Layer.mergeAll(
      GrantStore.layerInMemory(grants),
      Membership.layerNone,
      RevocationLog.layerInMemory,
      LensRegistry.layerFromCurrent(new Map()),
    );

  /** A write goes through `checkAccess(write)` first, then the CAS append. */
  const guardedWrite = Effect.fn('guardedWrite')(function* (
    next: ReturnType<typeof op>,
    commit: { base: ReturnType<typeof cid> | null; epoch: number },
  ) {
    const decision = yield* checkAccess({
      space: SPACE,
      did: next.author,
      action: 'write',
      collection: next.collection,
      now: NOW,
    });
    if (Decision.$is('Deny')(decision)) {
      return { outcome: 'denied' as const, reason: decision.reason };
    }
    const log = yield* SpaceWriteLog;
    const result = yield* log.append(REPO, next, commit).pipe(Effect.result);
    return Result.isSuccess(result)
      ? { outcome: 'committed' as const }
      : { outcome: 'conflict' as const };
  });

  const grant = stored({
    actions: ['write'],
    selectors: [{ collection: RUNS }],
  });

  it('issue -> commit; stale base -> conflict; revoke -> denied, head untouched', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* RevocationLog;
        yield* grants.openEpoch(grantRef(1).uri);
        const lock = yield* WriteLock;
        const log = yield* SpaceWriteLog;
        const epoch = yield* lock.acquire(SPACE);

        const committed = yield* guardedWrite(op({ cid: cid('bafy1') }), {
          base: null,
          epoch,
        });
        const conflict = yield* guardedWrite(
          op({ rkey: rkey('r2'), cid: cid('bafy2') }),
          { base: null, epoch },
        );
        const headBeforeRevoke = yield* log.head(REPO);

        yield* grants.append(grantRef(1).uri, 1);
        const denied = yield* guardedWrite(
          op({ rkey: rkey('r2'), cid: cid('bafy2') }),
          { base: headBeforeRevoke, epoch },
        );
        return {
          committed,
          conflict,
          denied,
          headBeforeRevoke,
          headAfter: yield* log.head(REPO),
        };
      }).pipe(Effect.provide(Layer.merge(policy([grant]), logLayer))),
    );
    expect(result.committed).toEqual({ outcome: 'committed' });
    expect(result.conflict).toEqual({ outcome: 'conflict' });
    expect(result.denied).toEqual({ outcome: 'denied', reason: 'revoked' });
    expect(result.headBeforeRevoke).toBe('bafy1');
    expect(result.headAfter).toBe('bafy1');
  });

  it('an author with no write grant is denied before the log is touched', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* SpaceWriteLog;
        const lock = yield* WriteLock;
        const epoch = yield* lock.acquire(SPACE);
        const outcome = yield* guardedWrite(
          op({ collection: NOTES, cid: cid('bafy1') }),
          { base: null, epoch },
        );
        return { outcome, entries: yield* log.entries(REPO) };
      }).pipe(Effect.provide(Layer.merge(policy([grant]), logLayer))),
    );
    expect(result.outcome).toEqual({ outcome: 'denied', reason: 'no-grant' });
    expect(result.entries).toEqual([]);
  });
});

describe('space write log: the present writer set', () => {
  it('lists only the repos that have written, with their last revision and head', async () => {
    const result = await run(
      Effect.gen(function* () {
        const { log, lock, epoch, write } = yield* writer;
        const empty = yield* log.repos(SPACE);
        yield* write(op({ cid: cid('bafy1') }), null);
        const bob = { space: SPACE, did: BOB };
        const bobEpoch = yield* lock.acquire(SPACE);
        yield* log.append(
          bob,
          op({
            cid: cid('bafy2'),
            rkey: rkey('r2'),
            rev: tid('aaaaaaaaaaaab'),
            author: BOB,
          }),
          { base: null, epoch: bobEpoch },
        );
        // A second space on the same log is not this space's answer.
        yield* log.append(
          { space: OTHER, did: ALICE },
          op({ cid: cid('bafy3'), space: OTHER }),
          { base: null, epoch: yield* lock.acquire(OTHER) },
        );
        return { empty, listed: yield* log.repos(SPACE), epoch };
      }),
    );
    expect(result.empty).toEqual([]);
    expect(result.listed).toEqual([
      { did: ALICE, rev: 'aaaaaaaaaaaaa', head: 'bafy1' },
      { did: BOB, rev: 'aaaaaaaaaaaab', head: 'bafy2' },
    ]);
  });
});
