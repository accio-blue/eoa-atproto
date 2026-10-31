import { Duration, Effect, Layer, Metric, Schedule } from 'effect';
import {
  storeBlockCacheEntries,
  storeHeldSnapshots,
  storeRuns,
  storeSequence,
} from './metrics.js';
import { LsmStats } from '@eoa/kv';

/**
 * The store's gauges, read from the store itself (ticket `mx29`, ADR 0009).
 *
 * A gauge counted outside the store drifts from it the moment the process
 * restarts, so these are read *from* the LSM: `LsmStats` is the store's own
 * account of its sequence, its runs by level, the snapshots readers hold, and
 * what its block cache holds.
 *
 * Only the LSM has runs and a block cache, so only the LSM reports them. The
 * filesystem WAL is the local default and leaves those gauges unset — the
 * decision `mx29` asked for, rather than a gauge that lies.
 */

/** How often the store is asked. A read is cheap; it is not a hot path. */
export const STORE_GAUGE_INTERVAL = Duration.seconds(15);

/** One read of the store, as the gauges. */
export const reportStoreGauges: Effect.Effect<void, never, LsmStats> =
  Effect.gen(function* () {
    const stats = yield* LsmStats;
    const current = yield* stats.read;
    yield* Metric.update(storeSequence, current.sequence);
    yield* Metric.update(storeHeldSnapshots, current.heldSnapshots);
    yield* Metric.update(storeBlockCacheEntries, current.blockCacheEntries);
    for (const level of current.runsByLevel) {
      yield* Metric.update(
        storeRuns.pipe(Metric.withAttributes({ level: String(level.level) })),
        level.runs,
      );
    }
  });

/**
 * The reporter: one read now, then one every `STORE_GAUGE_INTERVAL` — forever,
 * so the layer that owns it is what decides how long it lives.
 */
export const storeGauges = reportStoreGauges.pipe(
  Effect.repeat(Schedule.spaced(STORE_GAUGE_INTERVAL)),
);

/**
 * `storeGauges` as a layer: forked into the layer's own scope, so it stops with
 * the app rather than leaking a fiber, and so a deployment that runs the WAL
 * simply never builds it.
 */
export const storeGaugesLayer = Layer.effectDiscard(
  Effect.forkScoped(storeGauges),
);
