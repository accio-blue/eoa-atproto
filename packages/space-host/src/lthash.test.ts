import {
  constantTimeEqual,
  emptyLtHash,
  ltHashDigestOf,
  mixElements,
  serializeLtHash,
} from './lthash.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

const run = Effect.runPromise;

const element = (byte: number) => new Uint8Array([byte, byte + 1, byte + 2]);

describe('LtHash', () => {
  it('is order-independent', async () => {
    const [first, second, third] = [element(1), element(2), element(3)];
    const forward = await run(ltHashDigestOf([first, second, third]));
    const shuffled = await run(ltHashDigestOf([third, first, second]));
    expect([...shuffled]).toEqual([...forward]);
  });

  it('removing what was added returns to the empty state', async () => {
    const elements = [element(1), element(2)];
    const state = await run(mixElements(emptyLtHash(), elements, 1));
    const back = await run(mixElements(state, elements, -1));
    expect([...serializeLtHash(back)]).toEqual([
      ...serializeLtHash(emptyLtHash()),
    ]);
  });

  it('a different set commits to a different digest', async () => {
    const one = await run(ltHashDigestOf([element(1)]));
    const two = await run(ltHashDigestOf([element(1), element(2)]));
    expect(one.length).toBe(32);
    expect([...two]).not.toEqual([...one]);
  });

  it('compares bytes in constant time, length-aware', () => {
    expect(
      constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])),
    ).toBe(true);
    expect(
      constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])),
    ).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(
      false,
    );
  });
});
