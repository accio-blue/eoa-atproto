import {
  MAX_ROUND_ITERATIONS,
  hashPassword,
  roundsOf,
  verifyPassword,
} from './password.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

/**
 * The arithmetic that keeps a count inside the platform's cap.
 *
 * A Worker's WebCrypto refuses more than 100,000 iterations *in one call* — with a refusal that
 * names itself, quoted in `password.ts` — so the count a deployment asks for is spent in rounds.
 * This is the part of that which can be checked without a runtime enforcing the cap, and that
 * distinction is the point: the local simulator the tests run on takes 600,000 in one call and
 * answers happily, which is exactly how this was twice read as a CPU budget instead of a refusal.
 */
describe('the rounds a count is spent in', () => {
  it('never asks one call for more than the platform takes', () => {
    for (const total of [
      1, 999, 100_000, 100_001, 300_000, 600_000, 1_000_000,
    ]) {
      const { rounds, each } = roundsOf(total);
      expect(each).toBeLessThanOrEqual(MAX_ROUND_ITERATIONS);
      expect(rounds * each).toBeGreaterThanOrEqual(total);
      expect(rounds).toBe(Math.ceil(total / MAX_ROUND_ITERATIONS));
    }
  });

  it('spends the count a Worker refuses in one call across six of them', () => {
    expect(roundsOf(600_000)).toEqual({ rounds: 6, each: 100_000 });
  });

  it('asks for one round when one call is enough', () => {
    expect(roundsOf(100_000)).toEqual({ rounds: 1, each: 100_000 });
    expect(roundsOf(1_000)).toEqual({ rounds: 1, each: 1_000 });
  });
});

describe('a stored password', () => {
  it('round-trips at a count no single call would carry', async () => {
    const stored = await Effect.runPromise(hashPassword('a-password', 600_000));
    expect(stored.startsWith('pbkdf2c$600000$')).toBe(true);
    expect(await Effect.runPromise(verifyPassword('a-password', stored))).toBe(
      true,
    );
    expect(await Effect.runPromise(verifyPassword('another', stored))).toBe(
      false,
    );
  });

  it('still reads a row written before the rounds', async () => {
    // The shape the old code wrote: one call, at a count one call can carry. The marker changed,
    // the arithmetic did not, and the two paths have to agree exactly or a login breaks.
    const chained = await Effect.runPromise(hashPassword('a-password', 1_000));
    const legacy = chained.replace('pbkdf2c$', 'pbkdf2$');
    expect(await Effect.runPromise(verifyPassword('a-password', legacy))).toBe(
      true,
    );
    expect(await Effect.runPromise(verifyPassword('another', legacy))).toBe(
      false,
    );
  });

  it('refuses, rather than throws over, a row this runtime cannot check', async () => {
    // A single-call row above the cap. A Worker rejects the parameter before doing any work, so a
    // login that cannot be verified is refused — not an error thrown out of a login attempt, and
    // not a hash recomputed at some other count and compared.
    const stored = 'pbkdf2$600000$c2FsdA$aGFzaA';
    expect(await Effect.runPromise(verifyPassword('a-password', stored))).toBe(
      false,
    );
  });

  it('refuses anything that is not one of its two shapes', async () => {
    for (const stored of [
      '',
      'pbkdf2$1000$onlythree',
      'argon2id$1$salt$hash',
      'pbkdf2$0$c2FsdA$aGFzaA',
      'pbkdf2$notanumber$c2FsdA$aGFzaA',
    ]) {
      expect(
        await Effect.runPromise(verifyPassword('a-password', stored)),
      ).toBe(false);
    }
  });
});
