import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type { LexiconDoc } from './lexicon.js';
import { createLexicons } from './lexicon.js';
import { validateWithLexicon } from './validation.js';

/**
 * Every construct the vendored clipper lexicons use, in one def: `object` with
 * `required`/`properties`, `ref` (to a sibling def), `union` of refs, `array`
 * items, `string` formats and bounds, `integer` bounds, `cid-link`, `blob`,
 * `bytes`, `boolean`. `at.margin.note` and `network.cosmik.card` combine these
 * the same way.
 */
const docs: LexiconDoc[] = [
  {
    lexicon: 1,
    id: 'test.note',
    defs: {
      note: {
        type: 'object',
        required: ['$type', 'title', 'createdAt'],
        properties: {
          $type: { type: 'string' },
          title: { type: 'string', maxLength: 10 },
          createdAt: { type: 'string', format: 'datetime' },
          site: { type: 'string', format: 'at-uri' },
          tags: { type: 'array', items: { type: 'string' }, maxLength: 2 },
          count: { type: 'integer', minimum: 0 },
          nested: { type: 'ref', ref: 'test.note#inner' },
          link: { type: 'cid-link' },
          blob: { type: 'blob' },
          kind: { type: 'union', refs: ['test.note#a', 'test.note#b'] },
          payload: { type: 'bytes' },
          flag: { type: 'boolean' },
        },
      },
      inner: {
        type: 'object',
        required: ['n'],
        properties: { n: { type: 'integer', minimum: 1 } },
      },
      a: {
        type: 'object',
        required: ['a1'],
        properties: { a1: { type: 'string' } },
      },
      b: {
        type: 'object',
        required: ['b1'],
        properties: { b1: { type: 'string' } },
      },
    },
  },
];

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const lexicons = createLexicons(docs);
const note = lexicons.get('test.note')!.defs['note']!;

const valid: Readonly<Record<string, Schema.Json>> = {
  $type: 'test.note',
  title: 'hello',
  createdAt: '2026-10-21T12:00:00.000Z',
  site: 'at://did:plc:abc123/site.standard.document/3kxyz',
  tags: ['a', 'b'],
  count: 2,
  nested: { n: 1 },
  link: { $link: CID },
  blob: { $type: 'blob', ref: { $link: CID }, mimeType: 'text/plain', size: 3 },
  kind: { a1: 'x' },
  payload: 'aGVsbG8=',
  flag: true,
};

/** A copy of `valid` with one field replaced, so each case isolates one rule. */
const withField = (params: {
  readonly field: string;
  readonly value: Schema.Json;
}): Schema.Json => ({ ...valid, [params.field]: params.value });

const without = (field: string): Schema.Json => {
  const copy: Record<string, Schema.Json> = { ...valid };
  delete copy[field];
  return copy;
};

const run = (params: {
  readonly data: Schema.Json;
  readonly withRegistry?: boolean;
}) =>
  Effect.runPromise(
    Effect.result(
      validateWithLexicon({
        data: params.data,
        lexicon: note,
        ...(params.withRegistry === false ? {} : { lexicons }),
      }),
    ),
  );

const accepts = async (data: Schema.Json): Promise<boolean> =>
  (await run({ data }))._tag === 'Success';

describe('lexiconToSchema', () => {
  it('accepts a record that satisfies every construct', async () => {
    expect(await accepts(valid)).toBe(true);
  });

  it('keeps `$type` and fields the def does not declare (atproto objects are open)', async () => {
    const result = await run({ data: { ...valid, extra: 1 } });

    expect(result._tag).toBe('Success');
    if (result._tag !== 'Success') {
      return;
    }
    expect(result.success).toMatchObject({ $type: 'test.note', extra: 1 });
  });

  it('rejects a field of the wrong type', async () => {
    expect(await accepts(withField({ field: 'title', value: 42 }))).toBe(false);
    expect(await accepts(withField({ field: 'flag', value: 'yes' }))).toBe(
      false,
    );
  });

  it('rejects a missing required field', async () => {
    expect(await accepts(without('title'))).toBe(false);
    expect(await accepts(without('createdAt'))).toBe(false);
  });

  it('rejects a string that breaks its format', async () => {
    expect(
      await accepts(withField({ field: 'createdAt', value: 'nope' })),
    ).toBe(false);
    expect(await accepts(withField({ field: 'site', value: 'nope' }))).toBe(
      false,
    );
  });

  it('accepts a datetime with a numeric offset, not only Z', async () => {
    expect(
      await accepts(
        withField({ field: 'createdAt', value: '2026-10-19T09:16:36+03:00' }),
      ),
    ).toBe(true);
  });

  it('rejects a string that breaks its bounds', async () => {
    expect(
      await accepts(withField({ field: 'title', value: 'x'.repeat(11) })),
    ).toBe(false);
  });

  it('rejects an integer below its minimum', async () => {
    expect(await accepts(withField({ field: 'count', value: -1 }))).toBe(false);
  });

  it('rejects an array item of the wrong type and an over-long array', async () => {
    expect(await accepts(withField({ field: 'tags', value: ['a', 2] }))).toBe(
      false,
    );
    expect(
      await accepts(withField({ field: 'tags', value: ['a', 'b', 'c'] })),
    ).toBe(false);
  });

  it('resolves a ref through the registry, and applies its rules', async () => {
    expect(await accepts(withField({ field: 'nested', value: { n: 0 } }))).toBe(
      false,
    );
    expect(await accepts(withField({ field: 'nested', value: { n: 1 } }))).toBe(
      true,
    );
    expect(await accepts(withField({ field: 'nested', value: {} }))).toBe(
      false,
    );
  });

  it('resolves a union of refs', async () => {
    expect(
      await accepts(withField({ field: 'kind', value: { a1: 'x' } })),
    ).toBe(true);
    expect(
      await accepts(withField({ field: 'kind', value: { b1: 'x' } })),
    ).toBe(true);
    expect(await accepts(withField({ field: 'kind', value: { c: 'x' } }))).toBe(
      false,
    );
  });

  it('checks a cid-link and a blob', async () => {
    expect(
      await accepts(withField({ field: 'link', value: { $link: 5 } })),
    ).toBe(false);
    expect(
      await accepts(
        withField({ field: 'link', value: { $link: 'not-a-cid' } }),
      ),
    ).toBe(false);
    expect(
      await accepts(withField({ field: 'link', value: { $link: CID } })),
    ).toBe(true);
    expect(
      await accepts(withField({ field: 'blob', value: { $type: 'blob' } })),
    ).toBe(false);
  });

  it('checks that bytes are base64', async () => {
    expect(await accepts(withField({ field: 'payload', value: '!!!' }))).toBe(
      false,
    );
    expect(
      await accepts(withField({ field: 'payload', value: 'aGVsbG8=' })),
    ).toBe(true);
  });

  // A ref with nowhere to resolve is the one place the converter still has to
  // give up; callers that care pass the registry (assertValidXrpc* do).
  it('leaves a ref unvalidated when no registry is given', async () => {
    const result = await run({
      data: withField({ field: 'nested', value: { n: 0 } }),
      withRegistry: false,
    });
    expect(result._tag).toBe('Success');
  });
});
