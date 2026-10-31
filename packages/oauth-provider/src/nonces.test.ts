import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { memoryDpopNonces } from './nonces.js';

/**
 * The store’s half of the nonce rule, without a socket: the state machine
 * (`packages/oauth/src/dpop-nonce.ts`) folded over opaque nonces and jtis. The
 * route tests prove the wire shape; these prove the replay rule underneath it.
 */

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

const ORIGIN_A = 'https://a.example';
const ORIGIN_B = 'https://b.example';

describe('the DPoP nonce store', () => {
  it('challenges a proof with no nonce, and accepts it once the nonce is presented', async () => {
    const store = memoryDpopNonces();

    const challenged = await run(
      store.verify({ origin: ORIGIN_A, nonce: undefined, jti: 'j1' }),
    );
    expect(challenged.rejection).toBe('nonce');
    expect(challenged.nonce).toBeTruthy();

    const accepted = await run(
      store.verify({ origin: ORIGIN_A, nonce: challenged.nonce, jti: 'j2' }),
    );
    expect(accepted.rejection).toBeUndefined();
    // acceptance consumes the nonce: the one just used is no longer current
    expect(accepted.nonce).not.toBe(challenged.nonce);
  });

  it('refuses a nonce it has already consumed', async () => {
    const store = memoryDpopNonces();
    const first = await run(
      store.verify({ origin: ORIGIN_A, nonce: undefined, jti: 'j1' }),
    );
    const accepted = await run(
      store.verify({ origin: ORIGIN_A, nonce: first.nonce, jti: 'j2' }),
    );
    const replay = await run(
      store.verify({ origin: ORIGIN_A, nonce: first.nonce, jti: 'j3' }),
    );

    expect(accepted.rejection).toBeUndefined();
    expect(replay.rejection).toBe('nonce');
  });

  it('refuses a replayed jti, and does not burn the current nonce doing it', async () => {
    const store = memoryDpopNonces();
    const first = await run(
      store.verify({ origin: ORIGIN_A, nonce: undefined, jti: 'j1' }),
    );
    const accepted = await run(
      store.verify({ origin: ORIGIN_A, nonce: first.nonce, jti: 'j1' }),
    );
    const replay = await run(
      store.verify({ origin: ORIGIN_A, nonce: accepted.nonce, jti: 'j1' }),
    );
    // a jti refusal is not a nonce failure, so the current nonce still works
    const other = await run(
      store.verify({ origin: ORIGIN_A, nonce: accepted.nonce, jti: 'j2' }),
    );

    expect(accepted.rejection).toBeUndefined();
    expect(replay.rejection).toBe('jti');
    expect(other.rejection).toBeUndefined();
  });

  it('keeps nonces per origin, so another origin’s nonce does not satisfy us', async () => {
    const store = memoryDpopNonces();
    const atA = await run(
      store.verify({ origin: ORIGIN_A, nonce: undefined, jti: 'j1' }),
    );
    const foreign = await run(
      store.verify({ origin: ORIGIN_B, nonce: atA.nonce, jti: 'j2' }),
    );

    expect(foreign.rejection).toBe('nonce');
  });
});
