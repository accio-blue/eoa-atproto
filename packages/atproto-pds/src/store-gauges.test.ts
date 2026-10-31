import { Effect, Layer, Metric } from 'effect';
import { LsmStats, type StoreStats } from '@eoa/kv';
import { describe, expect, it } from 'vitest';
import { reportStoreGauges } from './store-gauges.js';
import { storeSequence } from './metrics.js';

/** The store's own account of itself, stubbed: the gauges only read it. */
const statsOf = (current: StoreStats) =>
  Layer.succeed(LsmStats, LsmStats.of({ read: Effect.succeed(current) }));

describe("the store's gauges", () => {
  it('reads the store and sets the sequence from it', async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        yield* reportStoreGauges;
        return yield* Metric.value(storeSequence);
      }).pipe(
        Effect.provide(
          statsOf({
            sequence: 42,
            runsByLevel: [{ level: 0, runs: 3 }],
            heldSnapshots: 1,
            blockCacheEntries: 7,
          }),
        ),
      ),
    );

    expect(seen.value).toBe(42);
  });
});
