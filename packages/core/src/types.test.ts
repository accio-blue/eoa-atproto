import { describe, expect, it } from 'vitest';
import { ATURI } from './types.js';
import { Schema } from 'effect';

describe('ATURI', () => {
  const is = Schema.is(ATURI);

  it('accepts DID and handle authorities', () => {
    expect(
      is(
        'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l',
      ),
    ).toBe(true);
    expect(is('at://did:web:example.com%3A8080/app.bsky.feed.post/abc')).toBe(
      true,
    );
    expect(is('at://bsky.app/app.bsky.feed.generator/whats-hot')).toBe(true);
  });

  it('rejects non at:// strings', () => {
    expect(is('https://bsky.app')).toBe(false);
    expect(is('at://')).toBe(false);
  });
});
