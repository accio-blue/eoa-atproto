import { Effect, Layer, Option } from 'effect';
import { type LsmOptions, LsmStats, kvLsmLayer } from './lsm.js';
import { ObjectStore, filesystemObjectStoreLayer } from '@eoa/object-store';
import { ShardLease, shardLeaseLayer } from './lease.js';
import { absentCondition, putOp } from './types.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { Kv } from './kv.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bytes = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

const read = (found: Option.Option<{ readonly value: Uint8Array }>) =>
  Option.isSome(found) ? text(found.value.value) : undefined;

const padded = (value: number) => String(value).padStart(16, '0');

/** The LSM over a filesystem store, with the lease it fences with. */
const layers = (directory: string, options: LsmOptions) => {
  const store = filesystemObjectStoreLayer(directory);
  return kvLsmLayer(options).pipe(
    Layer.provide([shardLeaseLayer.pipe(Layer.provide(store)), store]),
  );
};

const run = <A, E>(
  directory: string,
  threshold: number,
  effect: Effect.Effect<A, E, Kv>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.orDie, Effect.provide(layers(directory, { threshold }))),
  );

/** The bucket's listing, read through a second store over the same directory. */
const keysIn = (directory: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const objects = yield* ObjectStore;
      return (yield* objects.list()).keys;
    }).pipe(Effect.provide(filesystemObjectStoreLayer(directory))),
  );

const withDirectory = async <A>(body: (directory: string) => Promise<A>) => {
  const directory = await mkdtemp(join(tmpdir(), 'kv-lsm-'));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('the KV seam, as an LSM on the object store', () => {
  it('round-trips and survives a restart', async () => {
    const result = await withDirectory(async (directory) => {
      await run(
        directory,
        16,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          yield* kv.put('b', bytes('two'));
        }),
      );
      return await run(
        directory,
        16,
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

  it('writes a batch as one object, named by its sequence', async () => {
    const keys = await withDirectory(async (directory) => {
      await run(
        directory,
        16,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.batch([putOp({ key: 'a', value: bytes('one') })]);
        }),
      );
      return keysIn(directory);
    });

    expect(keys).toEqual([`log/${padded(1)}`]);
  });

  it('compacts the log into an SST, and still reads correctly', async () => {
    const result = await withDirectory(async (directory) => {
      const write = Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put('a', bytes('one'));
        yield* kv.put('b', bytes('two'));
        yield* kv.put('c', bytes('three'));
      });
      await run(directory, 2, write);

      const listing = await keysIn(directory);
      const after = await run(
        directory,
        2,
        Effect.gen(function* () {
          const kv = yield* Kv;
          const a = yield* kv.get('a');
          const c = yield* kv.get('c');
          return { a: read(a), c: read(c), sequence: yield* kv.sequence };
        }),
      );
      return { listing, after };
    });

    expect(
      result.listing.filter((name) => name.startsWith('sst/')),
    ).toHaveLength(1);
    expect(
      result.listing.filter((name) => name.startsWith('log/')),
    ).toHaveLength(1);
    expect(result.after.a).toBe('one');
    expect(result.after.c).toBe('three');
    expect(result.after.sequence).toBe(3);
  });

  it('refuses a create when the key is already there', async () => {
    const failure = await withDirectory((directory) =>
      run(
        directory,
        16,
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

  it('reads a past snapshot, under a hold', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        16,
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

  it('refuses a sequence another writer already claimed', () =>
    withDirectory(async (directory) => {
      const stack = layers(directory, { threshold: 8 });
      const write = (key: string, value: string) =>
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put(key, bytes(value));
        });

      const failure = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Both writers come up first, so both hold sequence 0 — the stale
            // one only finds out when the conditional PUT refuses its slot.
            const first = yield* Layer.build(stack);
            const second = yield* Layer.build(stack);
            yield* Effect.provide(write('a', 'one'), first);
            return yield* Effect.provide(
              Effect.flip(write('b', 'two')),
              second,
            );
          }),
        ).pipe(Effect.orDie),
      );

      expect(failure._tag).toBe('KeyPreconditionFailed');
    }));

  it('pages a scan and resumes from its cursor', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        16,
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

  it('fences a writer whose shard another owner has taken', () =>
    withDirectory(async (directory) => {
      const leased = layers(directory, {
        threshold: 8,
        lease: { shard: 's', owner: 'a' },
      });
      const leaseStack = shardLeaseLayer.pipe(
        Layer.provide(filesystemObjectStoreLayer(directory)),
      );
      const write = (key: string, value: string) =>
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put(key, bytes(value));
        });
      const takeOver = Effect.gen(function* () {
        const lease = yield* ShardLease;
        yield* lease.acquire('s', 'b');
      });

      const failure = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // The writer is already up, holding epoch 1 — the takeover is what
            // makes its next write fail, rather than a restart re-acquiring.
            const live = yield* Layer.build(leased);
            yield* Effect.provide(write('a', 'one'), live);
            yield* Effect.provide(takeOver, leaseStack);
            return yield* Effect.provide(Effect.flip(write('b', 'two')), live);
          }),
        ).pipe(Effect.orDie),
      );

      expect(failure._tag).toBe('KeyPreconditionFailed');
    }));

  it('recovers every object when the bucket lists in pages', async () => {
    // A bucket hands out a listing in pages (R2 and S3 stop at 1000); a store that lists two at a
    // time makes the page boundary land inside five log objects.
    const paged = (directory: string) => {
      const store = Layer.effect(
        ObjectStore,
        Effect.gen(function* () {
          const inner = yield* ObjectStore;
          return {
            ...inner,
            list: (options) => inner.list({ ...options, limit: 2 }),
          };
        }),
      ).pipe(Layer.provide(filesystemObjectStoreLayer(directory)));
      return kvLsmLayer({ threshold: 16 }).pipe(
        Layer.provide([shardLeaseLayer.pipe(Layer.provide(store)), store]),
      );
    };
    const result = await withDirectory(async (directory) => {
      await run(
        directory,
        16,
        Effect.gen(function* () {
          const kv = yield* Kv;
          for (const key of ['a', 'b', 'c', 'd', 'e']) {
            yield* kv.put(key, bytes(key));
          }
        }),
      );
      return await Effect.runPromise(
        Effect.gen(function* () {
          const kv = yield* Kv;
          return {
            e: read(yield* kv.get('e')),
            sequence: yield* kv.sequence,
          };
        }).pipe(Effect.orDie, Effect.provide(paged(directory))),
      );
    });

    expect(result).toEqual({ e: 'e', sequence: 5 });
  });

  it('reads a run back off the bucket after a restart', async () => {
    const result = await withDirectory(async (directory) => {
      await run(
        directory,
        1,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          yield* kv.put('b', bytes('two'));
        }),
      );
      const listing = await keysIn(directory);
      const after = await run(
        directory,
        1,
        Effect.gen(function* () {
          const kv = yield* Kv;
          return {
            a: read(yield* kv.get('a')),
            b: read(yield* kv.get('b')),
            sequence: yield* kv.sequence,
          };
        }),
      );
      return { listing, after };
    });

    expect(
      result.listing.filter((name) => name.startsWith('sst/')),
    ).toHaveLength(1);
    expect(result.after.a).toBe('one');
    expect(result.after.b).toBe('two');
    expect(result.after.sequence).toBe(2);
  });

  it('keeps a held snapshot readable through compaction', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        2,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const held = yield* kv.snapshot();
              yield* kv.put('a', bytes('two'));
              // Pushes the tail past the threshold, so compaction runs — and
              // the watermark is the hold, so `a` at 1 must survive it.
              yield* kv.put('b', bytes('three'));
              return {
                before: read(yield* kv.get('a', held)),
                now: read(yield* kv.get('a')),
              };
            }),
          );
        }),
      ),
    );

    expect(result.before).toBe('one');
    expect(result.now).toBe('two');
  });

  it('drops history nobody holds, and refuses to pretend otherwise', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        2,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          const first = yield* kv.sequence;
          yield* kv.put('a', bytes('two'));
          yield* kv.put('b', bytes('three'));
          const refused = yield* Effect.flip(kv.get('a', first));
          return { refused, now: read(yield* kv.get('a')) };
        }),
      ),
    );

    expect(result.refused._tag).toBe('SnapshotExpired');
    expect(result.now).toBe('two');
  });

  it('raises the watermark when the last hold lets go', async () => {
    const result = await withDirectory((directory) =>
      run(
        directory,
        2,
        Effect.gen(function* () {
          const kv = yield* Kv;
          yield* kv.put('a', bytes('one'));
          const first = yield* kv.sequence;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const held = yield* kv.snapshot(first);
              yield* kv.put('a', bytes('two'));
              yield* kv.put('b', bytes('three'));
              yield* kv.get('a', held);
            }),
          );
          return yield* Effect.flip(kv.get('a', first));
        }),
      ),
    );

    expect(result._tag).toBe('SnapshotExpired');
  });

  it('tiers runs, and merges a level into the next one', async () => {
    const result = await withDirectory(async (directory) => {
      // Twelve batches at a threshold of one: a run per flush, and a tier of two
      // means level 0 fills and merges repeatedly.
      const write = Effect.gen(function* () {
        const kv = yield* Kv;
        for (const at of Array.from({ length: 6 }, (_unused, index) => index)) {
          yield* kv.put(`k${at}`, bytes(`v${at}`));
          yield* kv.put(`k${at}`, bytes(`again${at}`));
        }
      });
      await Effect.runPromise(
        write.pipe(
          Effect.orDie,
          Effect.provide(layers(directory, { threshold: 1, tier: 2 })),
        ),
      );

      const listing = await keysIn(directory);
      const after = await Effect.runPromise(
        Effect.gen(function* () {
          const kv = yield* Kv;
          return {
            first: read(yield* kv.get('k0')),
            last: read(yield* kv.get('k5')),
            sequence: yield* kv.sequence,
          };
        }).pipe(
          Effect.orDie,
          Effect.provide(layers(directory, { threshold: 1, tier: 2 })),
        ),
      );
      return { listing, after };
    });

    // A run is an index *and* its blocks, and there is more than one run: a
    // flush no longer folds everything into a single object.
    expect(
      result.listing.filter((name) => name.startsWith('sst/')).length,
    ).toBeGreaterThan(1);
    expect(
      result.listing.filter((name) => name.startsWith('blk/')).length,
    ).toBeGreaterThan(1);
    // ...and the merges kept every value readable.
    expect(result.after.first).toBe('again0');
    expect(result.after.last).toBe('again5');
    expect(result.after.sequence).toBe(12);
  });

  it('reports its own shape: the sequence, the runs, the holds and the cache', () =>
    withDirectory(async (directory) => {
      const report = await Effect.runPromise(
        Effect.gen(function* () {
          const kv = yield* Kv;
          const stats = yield* LsmStats;

          const empty = yield* stats.read;
          yield* kv.put('k/one', bytes('one'));
          const written = yield* stats.read;

          // Two batches past the last flush make a run, and the flush empties
          // the memtable — so reading one back has to come from the run.
          yield* Effect.forEach(['k/a', 'k/b', 'k/c', 'k/d'], (key) =>
            kv.put(key, bytes(key)),
          );
          const flushed = yield* stats.read;
          yield* kv.get('k/one');
          const cached = yield* stats.read;

          const holding = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* kv.snapshot();
              return yield* stats.read;
            }),
          );

          return { empty, written, flushed, cached, holding };
        }).pipe(
          Effect.orDie,
          Effect.provide(layers(directory, { threshold: 2 })),
        ),
      );

      // Nothing yet: no writes, no runs, nothing held.
      expect(report.empty.sequence).toBe(0);
      expect(report.empty.runsByLevel).toEqual([]);
      expect(report.empty.heldSnapshots).toBe(0);
      // A write advances the head sequence...
      expect(report.written.sequence).toBeGreaterThan(0);
      // ...and a flush leaves a run at level 0 (the arithmetic is the flush's
      // business; this is the stats read reporting it).
      expect(report.flushed.runsByLevel[0]?.level).toBe(0);
      expect(report.flushed.runsByLevel[0]?.runs).toBeGreaterThan(0);
      // Reading a flushed run back caches a block.
      expect(report.cached.blockCacheEntries).toBeGreaterThan(0);
      // A held snapshot is counted while its scope lives.
      expect(report.holding.heldSnapshots).toBe(1);
    }));
});
