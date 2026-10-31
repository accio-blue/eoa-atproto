import { Effect, Option } from 'effect';
import { absentCondition, putOp, versionCondition } from './types.js';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Kv } from './kv.js';
import { join } from 'node:path';
import { kvFilesystemLayer } from './filesystem.js';
import { tmpdir } from 'node:os';

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const read = (found: Option.Option<{ readonly value: Uint8Array }>) =>
  Option.isSome(found) ? text(found.value.value) : undefined;

const run = <A, E>(directory: string, effect: Effect.Effect<A, E, Kv>) =>
  Effect.runPromise(
    effect.pipe(Effect.orDie, Effect.provide(kvFilesystemLayer(directory))),
  );

const withDirectory = async <A>(body: (directory: string) => Promise<A>) => {
  const directory = await mkdtemp(join(tmpdir(), 'kv-fs-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('the KV seam, on the filesystem', () => {
  it('survives a restart', async () => {
    const result = await withDirectory(async (directory) => {
      await run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          yield* kv.put('b', bytes('two'));
        }),
      );
      return await run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          const a = yield* kv.get('a');
          const b = yield* kv.get('b');
          return { a: read(a), b: read(b), sequence: yield* kv.sequence };
        }),
      );
    });

    expect(result.a).toBe('one');
    expect(result.b).toBe('two');
    expect(result.sequence).toBe(2);
  });

  it('refuses a create when the key is already there', async () => {
    const failure = await withDirectory((directory) =>
      run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          return yield* Effect.flip(
            kv.put('a', bytes('two'), absentCondition()),
          );
        }),
      ),
    );

    expect(failure._tag).toBe('KeyPreconditionFailed');
  });

  it('refuses a replace when the version has moved', async () => {
    const failure = await withDirectory((directory) =>
      run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          return yield* Effect.flip(
            kv.put('a', bytes('two'), versionCondition({ version: 99 })),
          );
        }),
      ),
    );

    expect(failure._tag).toBe('KeyPreconditionFailed');
  });

  it('refuses a batch atomically, and consumes no sequence', async () => {
    const result = await withDirectory(async (directory) => {
      await run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('y', bytes('pre'));
          yield* Effect.flip(
            kv.batch([
              putOp({ key: 'x', value: bytes('1') }),
              putOp({
                key: 'y',
                value: bytes('2'),
                condition: absentCondition(),
              }),
            ]),
          );
        }),
      );
      return await run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          return { sequence: yield* kv.sequence, x: yield* kv.get('x') };
        }),
      );
    });

    expect(result.sequence).toBe(1);
    expect(Option.isNone(result.x)).toBe(true);
  });

  it('reads a past snapshot, under a hold', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const held = yield* kv.snapshot();
              yield* kv.put('a', bytes('one'));
              const before = read(yield* kv.get('a', held));
              yield* kv.put('a', bytes('two'));
              return { before, now: read(yield* kv.get('a')) };
            }),
          );
        }),
      ),
    );

    expect(result.before).toBeUndefined();
    expect(result.now).toBe('two');
  });

  it('pages a scan and resumes from its cursor', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
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
            cursor,
            second: second?.entries.map((entry) => entry.key),
          };
        }),
      ),
    );

    expect(result.first).toEqual(['k/a', 'k/b']);
    expect(result.cursor).toBeDefined();
    expect(result.second).toEqual(['k/c']);
  });

  it('drops a torn tail rather than a committed log', async () => {
    const result = await withDirectory(async (directory) => {
      await run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
        }),
      );
      await appendFile(join(directory, 'kv.log'), '{"writes":[{"key":"b"');
      return await run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          return { a: read(yield* kv.get('a')), sequence: yield* kv.sequence };
        }),
      );
    });

    expect(result.a).toBe('one');
    expect(result.sequence).toBe(1);
  });

  it('refuses a log torn anywhere but the tail', async () => {
    const failure = await withDirectory(async (directory) => {
      await run(
        directory,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
        }),
      );
      await appendFile(join(directory, 'kv.log'), 'not a record\n');
      await appendFile(join(directory, 'kv.log'), '{"writes":[]}\n');
      return await Effect.runPromise(
        Effect.gen(function* () {
          const kv = yield* Kv;
          return yield* kv.sequence;
        }).pipe(Effect.provide(kvFilesystemLayer(directory)), Effect.flip),
      );
    });

    expect(failure._tag).toBe('KvUnavailable');
  });
});
