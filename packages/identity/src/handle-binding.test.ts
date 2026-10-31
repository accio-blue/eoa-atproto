import { describe, expect, it } from 'vitest';
import { latestHandleBinding, planHandleBinding } from './handle-binding.js';

const binding = (handle: string, account: string, seq: number) => ({
  handle,
  account,
  seq,
});

describe('handle binding policy', () => {
  it('picks the highest-seq binding for a handle', () => {
    const bindings = [
      binding('alice.example.com', 'alice', 1),
      binding('bob.example.com', 'bob', 2),
      binding('alice.example.com', 'carol', 5),
    ];

    expect(latestHandleBinding(bindings, 'alice.example.com')?.account).toBe(
      'carol',
    );
    expect(latestHandleBinding(bindings, 'nobody.example.com')).toBeUndefined();
  });

  it('classifies a first bind, a re-statement and a transfer', () => {
    const current = binding('alice.example.com', 'alice', 3);

    expect(planHandleBinding(undefined, current)).toBe('bind');
    expect(
      planHandleBinding(current, binding('alice.example.com', 'alice', 4)),
    ).toBe('noop');
    expect(
      planHandleBinding(current, binding('alice.example.com', 'carol', 4)),
    ).toBe('transfer');
  });
});
