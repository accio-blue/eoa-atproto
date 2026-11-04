/**
 * The upstream STAR interop vectors, run against the **framing** layer.
 *
 * The profile is deliberately not in the way: these archives are generic STAR,
 * while `atproto-space-repo` adds required meta fields, size ceilings and strict
 * key order. What is under test is the part every profile shares — magic,
 * metadata, the `0x01` that announces a pair, the `0x00` that ends the archive.
 *
 * The vectors are vendored; see `test/star-interop/README.md`.
 */
import {
  SPACE_RECORD_MAX_BYTES,
  starHeaderSync,
  starPairsSync,
} from './star.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

interface Valid {
  readonly comment: string;
  readonly star_hex: string;
  readonly decoded: {
    readonly meta: unknown;
    readonly pairs: ReadonlyArray<{
      readonly key_hex: string;
      readonly value_hex: string;
    }>;
  };
}

interface Invalid {
  readonly comment: string;
  readonly star_hex: string;
}

const load = <A>(name: string): A =>
  JSON.parse(
    readFileSync(
      new URL(`../test/star-interop/${name}`, import.meta.url),
      'utf8',
    ),
  ) as A;

const bytesOf = (hex: string) =>
  Uint8Array.from(
    hex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );

const framed = (hex: string) => {
  const bytes = bytesOf(hex);
  const header = starHeaderSync(bytes);
  return {
    meta: header.meta,
    pairs: starPairsSync(bytes, header.offset, SPACE_RECORD_MAX_BYTES),
  };
};

describe('STAR v1 framing, against the upstream vectors', () => {
  it('parses every archive that must parse, to exactly the decoded contents', () => {
    for (const vector of load<Valid[]>('valid-star-fixtures.json')) {
      const ours = framed(vector.star_hex);
      expect(ours.meta, vector.comment).toEqual(vector.decoded.meta);
      expect(
        ours.pairs.map((pair) => [[...pair.key], [...pair.value]]),
        vector.comment,
      ).toEqual(
        vector.decoded.pairs.map((pair) => [
          [...bytesOf(pair.key_hex)],
          [...bytesOf(pair.value_hex)],
        ]),
      );
    }
  });

  it('fails on every archive that must not parse', () => {
    for (const vector of load<Invalid[]>('invalid-star-fixtures.json')) {
      // Failing is the assertion; the reason is ours to choose.
      expect(
        () => framed(vector.star_hex),
        `${vector.comment} must not parse`,
      ).toThrow();
    }
  });
});
