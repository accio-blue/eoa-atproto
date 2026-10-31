import { describe, expect, it } from 'vitest';
import { referencesIn } from './references.js';

/** The references the samples below point at. */
const POST = 'at://did:plc:alice/app.bsky.feed.post/3jzsm4zqb2s2a';
const LIKED = 'at://did:plc:bob/app.bsky.feed.post/3k2la9x8w1';

describe('referencesIn', () => {
  it('finds nothing in a record with no references', () => {
    expect(
      referencesIn({ $type: 'app.bsky.feed.post', text: 'hello' }),
    ).toEqual([]);
  });

  it('finds one strongRef', () => {
    expect(
      referencesIn({
        $type: 'app.bsky.feed.like',
        subject: {
          uri: POST,
          cid: { $link: 'bafyreidfayvfuwqa7qlnopdjiqrxzs' },
        },
      }),
    ).toEqual([POST]);
  });

  it('finds two references in encounter order', () => {
    expect(referencesIn({ first: POST, second: { nested: LIKED } })).toEqual([
      POST,
      LIKED,
    ]);
  });

  it('lists a duplicate reference once, at its first position', () => {
    expect(referencesIn({ first: POST, second: POST })).toEqual([POST]);
  });

  it('walks nested arrays and objects', () => {
    expect(
      referencesIn({
        items: [{ uri: POST }, { deep: { uri: LIKED } }],
      }),
    ).toEqual([POST, LIKED]);
  });

  it('does not mistake a blob reference for an AT-URI', () => {
    expect(
      referencesIn({
        $type: 'blob',
        ref: {
          $link: 'bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy',
        },
      }),
    ).toEqual([]);
  });
});
