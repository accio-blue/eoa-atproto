import {
  type DurableStorage,
  kvDurableLayer,
  migrateStore,
} from './durable.js';
import { Effect, Layer, Option } from 'effect';
import {
  Holds,
  type Log,
  type State,
  type Versioned,
  holdsLayer,
} from './engine.js';
import { describe, expect, it } from 'vitest';
import { Kv } from './kv.js';

// The backend a Durable Object uses, and the reason it has been bounded twice (`tie8`, `xblb`): a
// value caps at 128 KiB, so every layout that put more than one record in a value refused to save a
// collection. Now the row *is* the key. What matters here: a point read touches one row, a scan
// reads its page and resumes from its cursor, a deleted key does not shorten a page, and a store from
// either earlier shape is migrated once without losing anything.

/** The rows a durable backend holds, and the `list` a scan finds them with. */
const storageOf = (seed?: ReadonlyArray<readonly [string, unknown]>) => {
  const rows = new Map<string, unknown>(seed ?? []);
  const storage: DurableStorage = {
    // A test double for a generic interface: the only things this backend is handed are a head, one
    // key's versions, and the buckets a store from before the rows left behind.
    get: async <A>(key: string): Promise<A | undefined> =>
      rows.get(key) as A | undefined,
    getMany: async <A>(
      keys: ReadonlyArray<string>,
    ): Promise<ReadonlyMap<string, A>> =>
      new Map(
        keys.flatMap((key) =>
          rows.has(key) ? [[key, rows.get(key) as A] as const] : [],
        ),
      ),
    put: async <A>(key: string, value: A): Promise<void> => {
      rows.set(key, value);
    },
    list: async (options) => {
      const matching = [...rows.keys()]
        .filter(
          (key) =>
            options?.prefix === undefined || key.startsWith(options.prefix),
        )
        .filter((key) => options?.start === undefined || key >= options.start)
        .sort();
      return options?.limit === undefined
        ? matching
        : matching.slice(0, options.limit);
    },
  };
  return {
    storage,
    rows,
    /** A key's versions as they were written, or a failure that says why the row is missing. */
    versionsOf: (key: string): ReadonlyArray<Versioned> => {
      const held = rows.get(`kv.k/${key}`);
      if (!isVersions(held)) {
        throw new Error(`no row for ${key}`);
      }
      return held;
    },
    keyRows: (): ReadonlyArray<string> =>
      [...rows.keys()].flatMap((key) =>
        key.startsWith('kv.k/') ? [key.slice('kv.k/'.length)] : [],
      ),
  };
};

const isVersions = (value: unknown): value is ReadonlyArray<Versioned> =>
  Array.isArray(value);

const layerFor = (storage: DurableStorage) =>
  kvDurableLayer(storage).pipe(Layer.provideMerge(holdsLayer));

const bytes = (text: string) => new TextEncoder().encode(text);

const textOf = (value: Uint8Array | undefined) =>
  value === undefined ? undefined : new TextDecoder().decode(value);

const run = <A>(
  storage: DurableStorage,
  work: (kv: typeof Kv.Service) => Effect.Effect<A, unknown, Holds>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const kv = yield* Kv;
      return yield* work(kv);
    }).pipe(Effect.provide(layerFor(storage))),
  );

const RECORDS = 'R/did:web:x/ing.lexicon.issue/';

describe('the durable backend, whose row is a key', () => {
  it('drops every version no snapshot can still read', async () => {
    const held = storageOf();

    await run(held.storage, (kv) =>
      Effect.gen(function* () {
        yield* kv.put('a', bytes('one'));
        yield* kv.put('a', bytes('two'));
        yield* kv.put('a', bytes('three'));
        const found = yield* kv.get('a');
        expect(Option.map(found, (one) => textOf(one.value))).toEqual(
          Option.some('three'),
        );
      }),
    );

    const versions = held.versionsOf('a');
    expect(versions).toHaveLength(1);
    expect(textOf(versions[0]?.value)).toBe('three');
  });

  it('keeps what a held snapshot can still read: the history is the hold, and nothing else', async () => {
    const held = storageOf();

    await run(held.storage, (kv) =>
      Effect.gen(function* () {
        const holds = yield* Holds;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const at = yield* holds.snapshot(1);
            yield* kv.put('a', bytes('one'));
            yield* kv.put('a', bytes('two'));
            yield* kv.put('a', bytes('three'));
            // A read at the hold is what the hold is for: the version eviction must not have dropped.
            const then = yield* kv.get('a', at);
            expect(Option.map(then, (one) => textOf(one.value))).toEqual(
              Option.some('one'),
            );
          }),
        );
      }),
    );

    expect(held.versionsOf('a').length).toBeGreaterThan(1);
  });

  it('is a row per key, so no collection and no store is ever one value', async () => {
    const held = storageOf();

    await run(held.storage, (kv) =>
      Effect.gen(function* () {
        yield* kv.put(`${RECORDS}one`, bytes('a'));
        yield* kv.put(`${RECORDS}two`, bytes('b'));
        yield* kv.put('A/did:web:x', bytes('an account'));
      }),
    );

    expect([...held.keyRows()].sort()).toEqual([
      'A/did:web:x',
      `${RECORDS}one`,
      `${RECORDS}two`,
    ]);
    expect(held.rows.has('kv.state')).toBe(false);
    expect(held.rows.get('kv.head')).toEqual({ sequence: 3, layout: 'rows' });
  });

  it('pages a collection with its cursor, and a deleted key does not shorten a page', async () => {
    const held = storageOf();

    await run(held.storage, (kv) =>
      Effect.gen(function* () {
        for (const rkey of ['a', 'b', 'c', 'd']) {
          yield* kv.put(`${RECORDS}${rkey}`, bytes(rkey));
        }
        yield* kv.delete(`${RECORDS}b`);
        yield* kv.put(
          'R/did:web:x/ing.lexicon.issue-label/ui',
          bytes('elsewhere'),
        );

        const first = yield* kv.scan({ prefix: RECORDS, limit: 2 });
        expect(first.entries.map((one) => one.key)).toEqual([
          `${RECORDS}a`,
          `${RECORDS}c`,
        ]);
        // Three entries survived the deletion, so there is a page after this one.
        expect(first.cursor).toBeDefined();

        const second = yield* kv.scan({
          prefix: RECORDS,
          limit: 2,
          ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
        });
        expect(second.entries.map((one) => one.key)).toEqual([`${RECORDS}d`]);
        expect(second.cursor).toBeUndefined();
      }),
    );
  });

  it('migrates the store that was one value, and keeps it', async () => {
    const legacy: State = {
      sequence: 7,
      log: new Map([
        ['A/did:web:x', [{ version: 2, value: bytes('an account') }]],
        [`${RECORDS}one`, [{ version: 6, value: bytes('a') }]],
        [`${RECORDS}two`, [{ version: 7, value: bytes('b') }]],
      ]),
    };
    const held = storageOf([['kv.state', legacy]]);

    await run(held.storage, (kv) =>
      Effect.gen(function* () {
        const found = yield* kv.get('A/did:web:x');
        expect(Option.map(found, (one) => textOf(one.value))).toEqual(
          Option.some('an account'),
        );
        expect(yield* kv.sequence).toBe(7);
        // And a write after the migration keeps counting where it left off rather than starting over.
        yield* kv.put('A/did:web:y', bytes('another'));
        expect(yield* kv.sequence).toBe(8);
      }),
    );

    expect([...held.keyRows()].sort()).toEqual([
      'A/did:web:x',
      'A/did:web:y',
      `${RECORDS}one`,
      `${RECORDS}two`,
    ]);
    expect(held.rows.get('kv.head')).toEqual({ sequence: 8, layout: 'rows' });
    // The value a deployment was running on before the migration is still there: nothing deleted it.
    expect(held.rows.get('kv.state')).toEqual(legacy);
  });

  it('migrates the buckets that replaced it, and keeps them too', async () => {
    const buckets = new Map<string, Log>([
      [
        'kv.log/A/',
        new Map([
          ['A/did:web:x', [{ version: 2, value: bytes('an account') }]],
        ]),
      ],
      [
        `kv.log/${RECORDS}`,
        new Map([
          [`${RECORDS}one`, [{ version: 6, value: bytes('a') }]],
          [
            `${RECORDS}two`,
            [
              { version: 7, value: bytes('b') },
              // A write that landed after the bucket migration: the buckets are the newer source.
              { version: 9, value: bytes('b again') },
            ],
          ],
        ]),
      ],
    ]);
    const held = storageOf([
      ['kv.state', { sequence: 7, log: new Map() } satisfies State],
      ...buckets,
      ['kv.head', { sequence: 9 }],
    ]);

    await run(held.storage, (kv) =>
      Effect.gen(function* () {
        const found = yield* kv.get(`${RECORDS}two`);
        expect(Option.map(found, (one) => textOf(one.value))).toEqual(
          Option.some('b again'),
        );
        expect(yield* kv.sequence).toBe(9);
      }),
    );

    expect([...held.keyRows()].sort()).toEqual([
      'A/did:web:x',
      `${RECORDS}one`,
      `${RECORDS}two`,
    ]);
    expect(held.rows.get('kv.head')).toEqual({ sequence: 9, layout: 'rows' });
    for (const [row, log] of buckets) {
      expect(held.rows.get(row)).toEqual(log);
    }
  });

  it('runs the migration before any request, and a second run is a read', async () => {
    const held = storageOf([
      [
        'kv.state',
        {
          sequence: 4,
          log: new Map([['a', [{ version: 4, value: bytes('one') }]]]),
        } satisfies State,
      ],
    ]);

    await migrateStore(held.storage);
    expect(held.rows.get('kv.head')).toEqual({ sequence: 4, layout: 'rows' });
    expect(textOf(held.versionsOf('a')[0]?.value)).toBe('one');

    // Idempotent by construction: the head's layout is what says it is done, so a second call reads
    // it and writes nothing.
    await migrateStore(held.storage);
    expect(held.versionsOf('a')).toHaveLength(1);
    expect(held.rows.get('kv.head')).toEqual({ sequence: 4, layout: 'rows' });
  });

  it('answers a scan with the same page the engine would, tombstones and all', async () => {
    // The row walk reads as few rows as it can, so this is the test that it never reads too few: a
    // deleted key between two pages must not hide the entry behind it.
    const held = storageOf();
    const rkeys = ['a', 'b', 'c', 'd', 'e', 'f'];

    await run(held.storage, (kv) =>
      Effect.gen(function* () {
        for (const rkey of rkeys) {
          yield* kv.put(`${RECORDS}${rkey}`, bytes(rkey));
        }
        for (const rkey of ['b', 'd']) {
          yield* kv.delete(`${RECORDS}${rkey}`);
        }

        const walked: Array<string> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const one = yield* kv.scan({
            prefix: RECORDS,
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          });
          walked.push(...one.entries.map((entry) => entry.key));
          cursor = one.cursor;
          if (cursor === undefined) {
            break;
          }
        }
        expect(walked).toEqual([
          `${RECORDS}a`,
          `${RECORDS}c`,
          `${RECORDS}e`,
          `${RECORDS}f`,
        ]);
      }),
    );
  });
});
