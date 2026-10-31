import { Effect, Option } from 'effect';
import { absentCondition, putOp, versionCondition } from './types.js';
import { describe, expect, it } from 'vitest';
import { Kv } from './kv.js';
import { kvMemoryLayer } from './memory.js';

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const run = <A, E>(effect: Effect.Effect<A, E, Kv>) =>
  Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(kvMemoryLayer)));

const read = (found: Option.Option<{ readonly value: Uint8Array }>) =>
  Option.isSome(found) ? text(found.value.value) : undefined;

describe('the KV seam, in memory', () => {
  it('stamps a version per commit and reads it back', async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        const first = yield* kv.put('a', bytes('one'));
        const second = yield* kv.put('a', bytes('two'));
        const found = yield* kv.get('a');
        const missing = yield* kv.get('nope');
        return { first, second, found, missing };
      }),
    );

    expect(result.first).toBe(1);
    expect(result.second).toBe(2);
    expect(read(result.found)).toBe('two');
    expect(Option.isNone(result.missing)).toBe(true);
  });

  it('refuses a create when the key is already there', async () => {
    const failure = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put('a', bytes('one'));
        return yield* Effect.flip(kv.put('a', bytes('two'), absentCondition()));
      }),
    );

    expect(failure._tag).toBe('KeyPreconditionFailed');
  });

  it('refuses a replace when the version has moved', async () => {
    const failure = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put('a', bytes('one'));
        return yield* Effect.flip(
          kv.put('a', bytes('two'), versionCondition({ version: 99 })),
        );
      }),
    );

    expect(failure._tag).toBe('KeyPreconditionFailed');
  });

  it('deletes, and a writer still sees its own write', async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put('a', bytes('one'));
        const seen = yield* kv.get('a');
        yield* kv.delete('a');
        const gone = yield* kv.get('a');
        return { seen: read(seen), absent: Option.isNone(gone) };
      }),
    );

    expect(result.seen).toBe('one');
    expect(result.absent).toBe(true);
  });

  it('applies a batch atomically, or not at all', async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put('y', bytes('pre'));
        const before = yield* kv.sequence;
        const failure = yield* Effect.flip(
          kv.batch([
            putOp({ key: 'x', value: bytes('1') }),
            putOp({
              key: 'y',
              value: bytes('2'),
              condition: absentCondition(),
            }),
          ]),
        );
        const after = yield* kv.sequence;
        const x = yield* kv.get('x');
        return { failure, before, after, absent: Option.isNone(x) };
      }),
    );

    expect(result.failure._tag).toBe('KeyPreconditionFailed');
    expect(result.before).toBe(result.after);
    expect(result.absent).toBe(true);
  });

  it('reads a past snapshot, under a hold', async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // A hold is taken *before* the writes it pins — MVCC, not
            // time travel: history is read as of when the reader started.
            const held = yield* kv.snapshot();
            yield* kv.put('a', bytes('one'));
            const beforeIt = read(yield* kv.get('a', held));
            yield* kv.put('a', bytes('two'));
            return { beforeIt, now: read(yield* kv.get('a')) };
          }),
        );
      }),
    );

    expect(result.beforeIt).toBeUndefined();
    expect(result.now).toBe('two');
  });

  it('refuses a past read nobody holds', async () => {
    const failure = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put('a', bytes('one'));
        return yield* Effect.flip(kv.get('a', 0));
      }),
    );

    expect(failure._tag).toBe('SnapshotExpired');
  });

  it('refuses a hold below the watermark', async () => {
    const failure = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put('a', bytes('one'));
        return yield* Effect.flip(kv.snapshot(0).pipe(Effect.scoped));
      }),
    );

    expect(failure._tag).toBe('SnapshotExpired');
  });

  it('pages a scan and resumes from its cursor', async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.batch([
          putOp({ key: 'k/a', value: bytes('a') }),
          putOp({ key: 'k/b', value: bytes('b') }),
          putOp({ key: 'k/c', value: bytes('c') }),
          putOp({ key: 'z/one', value: bytes('z') }),
        ]);
        const first = yield* kv.scan({ prefix: 'k/', limit: 2 });
        const cursor = first.cursor;
        const second =
          cursor === undefined
            ? undefined
            : yield* kv.scan({ prefix: 'k/', limit: 2, cursor });
        return {
          first: first.entries.map((entry) => entry.key),
          firstCursor: cursor,
          second: second?.entries.map((entry) => entry.key),
          secondCursor: second?.cursor,
        };
      }),
    );

    expect(result.first).toEqual(['k/a', 'k/b']);
    expect(result.firstCursor).toBeDefined();
    expect(result.second).toEqual(['k/c']);
    expect(result.secondCursor).toBeUndefined();
  });

  it('rejects a cursor that disagrees with the snapshot', async () => {
    const failure = await run(
      Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.batch([
          putOp({ key: 'a', value: bytes('a') }),
          putOp({ key: 'b', value: bytes('b') }),
        ]);
        const page = yield* kv.scan({ limit: 1 });
        const cursor = page.cursor;
        return cursor === undefined
          ? undefined
          : yield* Effect.flip(kv.scan({ cursor, at: 99 }));
      }),
    );

    expect(failure?._tag).toBe('CursorInvalid');
  });
});
