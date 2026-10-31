import { AccountStore, accountStoreLayer } from './account-store.js';
import { Effect, Layer, Metric } from 'effect';
import {
  accountsCreated,
  accountsRefused,
  requestMetrics,
  requests,
} from './metrics.js';
import { describe, expect, it } from 'vitest';
import { XrpcError } from '@eoa/xrpc-server';
import { kvMemoryLayer } from '@eoa/kv';

/**
 * The metrics move when the thing they count does (ticket `i1vo`). The names
 * are the contract the dashboard reads, so this pins the two a registration
 * produces: a creation, and a refusal.
 */

const withStore = <A, E>(
  use: (store: AccountStore['Service']) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AccountStore;
      return yield* use(store);
    }).pipe(
      Effect.provide(accountStoreLayer.pipe(Layer.provide(kvMemoryLayer))),
    ),
  );

const createParams = (did: string, handle: string) => ({
  did,
  handle,
  email: null,
  passwordHash: 'pbkdf2$1$salt$hash',
  inviteCode: undefined,
  inviteRequired: false,
  now: 1000,
});

const handleTakenCount = Metric.value(
  accountsRefused.pipe(Metric.withAttributes({ reason: 'handle_taken' })),
).pipe(Effect.map((state) => state.count));

/** The request counter for one status of the method the test asks for. */
const requestCount = (status: number) =>
  Metric.value(
    requests.pipe(
      Metric.withAttributes({
        method: 'com.atproto.repo.getRecord',
        status: String(status),
      }),
    ),
  ).pipe(Effect.map((state) => state.count));

describe('the PDS metrics', () => {
  it('counts a creation and a refusal', async () => {
    const report = await withStore((store) =>
      Effect.gen(function* () {
        const createdBefore = (yield* Metric.value(accountsCreated)).count;
        const takenBefore = yield* handleTakenCount;
        yield* store.create(createParams('did:web:one', 'alice.pds.example'));
        yield* store.create(createParams('did:web:two', 'alice.pds.example'));
        const createdAfter = (yield* Metric.value(accountsCreated)).count;
        const takenAfter = yield* handleTakenCount;
        return {
          created: createdAfter - createdBefore,
          taken: takenAfter - takenBefore,
        };
      }),
    );

    expect(report.created).toBe(1);
    expect(report.taken).toBe(1);
  });

  it('counts a request by its method and status, a refusal included', async () => {
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = {
          params: {},
          nsid: 'com.atproto.repo.getRecord',
          headers: {},
        };
        const before = yield* requestCount(200);
        const refusedBefore = yield* requestCount(401);

        const answered = requestMetrics(() => Effect.succeed({ ok: true }));
        const refused = requestMetrics(() =>
          Effect.fail(
            new XrpcError({
              error: 'AuthRequired',
              message: 'no',
              status: 401,
            }),
          ),
        );
        yield* answered(ctx);
        // A refusal is a failure of the effect, which the transport answers
        // with the status the error carries.
        yield* Effect.exit(refused(ctx));

        return {
          served: (yield* requestCount(200)) - before,
          refused: (yield* requestCount(401)) - refusedBefore,
        };
      }),
    );

    expect(report.served).toBe(1);
    expect(report.refused).toBe(1);
  });
});
