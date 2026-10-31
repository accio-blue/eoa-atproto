import { type DurableStorage, holdsLayer, kvDurableLayer } from '@eoa/kv';
import { Effect, Layer } from 'effect';
import { applyWrite, createRepo } from './repo-write.js';
import { describe, expect, it } from 'vitest';
import { generateES256KeyPair } from '@eoa/crypto';
import { repoStoreLayer } from './repo-store.js';

/** A Durable Object's storage, counting what a deployment is billed for: rows read and written. */
const countingStorage = () => {
  const rows = new Map<string, unknown>();
  const spent = { written: 0, reads: 0 };
  const storage: DurableStorage = {
    get: async (key: string) => {
      spent.reads += 1;
      return rows.get(key) as never;
    },
    getMany: async (keys: ReadonlyArray<string>) => {
      spent.reads += keys.length;
      const found = new Map<string, unknown>();
      for (const key of keys) {
        if (rows.has(key)) {
          found.set(key, rows.get(key));
        }
      }
      return found as never;
    },
    put: async (key: string, value: unknown) => {
      spent.written += 1;
      rows.set(key, value);
    },
    list: async (options?: {
      prefix?: string;
      start?: string;
      limit?: number;
    }) =>
      [...rows.keys()]
        .filter(
          (key) =>
            options?.prefix === undefined || key.startsWith(options.prefix),
        )
        .filter((key) => options?.start === undefined || key >= options.start)
        .sort()
        .slice(0, options?.limit),
  };
  return { storage, spent };
};

describe('what one record write costs', () => {
  it('is five rows, not eight: the commit is one storage batch', async () => {
    const { storage, spent } = countingStorage();
    const key = await Effect.runPromise(generateES256KeyPair());
    const writes = 5;
    let opened = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* createRepo({
          did: 'did:plc:rows',
          signingKey: key.privateKey,
          now: 1_700_000_000_000,
          clockId: 0,
        });
        opened = spent.written;
        for (let at = 0; at < writes; at += 1) {
          yield* applyWrite({
            did: 'did:plc:rows',
            key: `app.rows.record/${at}`,
            record: { $type: 'app.rows.record', n: at },
            swapCommit: undefined,
            signingKey: key.privateKey,
            now: 1_700_000_001_000 + at * 1_000,
            clockId: 0,
          });
        }
      }).pipe(
        Effect.provide(
          repoStoreLayer.pipe(
            Layer.provide(
              kvDurableLayer(storage).pipe(Layer.provideMerge(holdsLayer)),
            ),
          ),
        ),
      ),
    );

    // Four keys are a record write's business (the record, a tree node, the commit, the head) and one
    // more is the store's own head. As four separate commits that head row is paid four times -- 8
    // rows a record. Collected into one batch it is paid once, which is what this pins: a regression
    // back to per-call commits fails here.
    const perRecord = (spent.written - opened) / writes;
    expect(perRecord).toBeLessThan(7.5);
  });
});
