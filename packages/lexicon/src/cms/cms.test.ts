import {
  CUSTOM_SECTION_NSID,
  CUSTOM_TYPE_NSID,
  CustomSectionSchema,
  CustomTypeSchema,
} from './model.js';
import {
  DOCUMENT_NSID,
  DRAFT_NSID,
  DocumentSchema,
  DraftSchema,
} from './document.js';
import type { Def, DefsDoc } from '../test-utils.js';
import { createLexicons, isLexiconDoc } from '../index.js';
import {
  dataSchemaForType,
  sectionSchemaForVariation,
} from './field-schema.js';
import { describe, expect, it } from 'vitest';
import {
  globalType,
  mediaSection,
  pageType,
  sampleDocument,
  sampleSectionEntry,
} from './fixtures.js';
import { FieldDefSchema } from './defs.js';
import { Schema } from 'effect';
import { decodeDefsDoc } from '../test-utils.js';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/cms (this file is src/cms).
const HOME = new URL('../../lexicons/ing/lexicon/cms/', import.meta.url);
const NAMES = [
  'defs',
  'type',
  'section',
  'document',
  'draft',
  'content',
] as const;
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`${name}.json`, HOME)), 'utf-8');

const raw = NAMES.map((n) => parseJson(read(n)));
const docs = raw.filter(isLexiconDoc);
const lexicons = createLexicons(docs);
const defsDocs: DefsDoc[] = raw.map((r) => decodeDefsDoc(r));

const findDef = ({
  nsid,
  name = 'main',
}: {
  readonly nsid: string;
  readonly name?: string;
}): Def => {
  const def = defsDocs.find((d) => d.id === nsid)?.defs[name];
  if (def === undefined) {
    throw new Error(`no def ${nsid}#${name}`);
  }
  return def;
};

const resolves = ({
  ref,
  base,
}: {
  readonly ref: string;
  readonly base: string;
}): boolean => {
  const [head = '', name = 'main'] = ref.split('#');
  const nsid = head === '' ? base : head;
  return defsDocs.some((d) => d.id === nsid && d.defs[name] !== undefined);
};

const collectRefs = ({
  def,
  into,
}: {
  readonly def: Def;
  readonly into: Set<string>;
}): void => {
  if (def.ref !== undefined) {
    into.add(def.ref);
  }
  for (const r of def.refs ?? []) {
    into.add(r);
  }
  Object.values(def.properties ?? {}).forEach((p) =>
    collectRefs({ def: p, into }),
  );
  if (def.items) {
    collectRefs({ def: def.items, into });
  }
  if (def.record) {
    collectRefs({ def: def.record, into });
  }
};

describe('ing.lexicon.cms lexicons', () => {
  it('are lexicon docs the registry accepts, one per file', () => {
    expect(raw.every((d) => isLexiconDoc(d) && d.lexicon === 1)).toBe(true);
    expect(lexicons.ids).toEqual([
      'ing.lexicon.cms.defs',
      CUSTOM_TYPE_NSID,
      CUSTOM_SECTION_NSID,
      DOCUMENT_NSID,
      DRAFT_NSID,
      'ing.lexicon.cms.content',
    ]);
  });

  it('key the model records by name and keep document data open', () => {
    expect(findDef({ nsid: CUSTOM_TYPE_NSID }).key).toBe('any');
    expect(findDef({ nsid: CUSTOM_SECTION_NSID }).key).toBe('any');
    const doc = findDef({ nsid: DOCUMENT_NSID });
    expect(doc.key).toBe('any');
    expect(doc.record?.properties?.['data']?.type).toBe('unknown');
  });

  it('resolve every ref and union ref', () => {
    for (const doc of defsDocs) {
      for (const def of Object.values(doc.defs)) {
        const refs = new Set<string>();
        collectRefs({ def, into: refs });
        for (const ref of refs) {
          expect(resolves({ ref, base: doc.id }), `${doc.id}: ${ref}`).toBe(
            true,
          );
        }
      }
    }
  });
});

describe('the content model decodes', () => {
  it('decodes a custom type, a slice, and a document', () => {
    expect(Schema.is(CustomTypeSchema)(pageType)).toBe(true);
    expect(Schema.is(CustomSectionSchema)(mediaSection)).toBe(true);
    expect(Schema.is(DocumentSchema)(sampleDocument)).toBe(true);
  });

  it('rejects an unknown field kind and type kind', () => {
    const decType = Schema.decodeUnknownSync(CustomTypeSchema);
    expect(() => decType({ ...pageType, kind: 'list' })).toThrow();
    const decField = Schema.decodeUnknownSync(FieldDefSchema);
    expect(() => decField({ key: 'x', type: 'wysiwyg' })).toThrow();
  });

  it('rejects a document without a uid, and keeps a draft the same shape', () => {
    const decDoc = Schema.decodeUnknownSync(DocumentSchema);
    const noUid: { [key: string]: unknown } = { ...sampleDocument };
    delete noUid['uid'];
    expect(() => decDoc(noUid)).toThrow();

    const asDraft = { ...sampleDocument };
    delete asDraft.$type;
    expect(Schema.is(DraftSchema)(asDraft)).toBe(true);
  });
});

describe('the schema-from-type builder', () => {
  it('validates a document data object against its type', () => {
    const data = dataSchemaForType({ type: pageType });
    expect(Schema.is(data)(sampleDocument.data)).toBe(true);
    const dec = Schema.decodeUnknownSync(data);
    expect(() =>
      dec({ ...sampleDocument.data, title: 'not portable text' }),
    ).toThrow();
  });

  it('validates a slice primary against its variation', () => {
    const variation = mediaSection.variations[0];
    if (variation === undefined) {
      throw new Error('media slice has no variation');
    }
    const schema = sectionSchemaForVariation({ variation });
    expect(
      Schema.is(schema)({
        primary: sampleSectionEntry.primary ?? {},
        items: [],
      }),
    ).toBe(true);
    const dec = Schema.decodeUnknownSync(schema);
    expect(() => dec({ primary: { media: 'nope' } })).toThrow();
  });

  it('repeats any kind, not just a group', () => {
    const schema = sectionSchemaForVariation({
      variation: {
        id: 'gallery',
        name: 'Gallery',
        primary: [
          { key: 'images', type: 'image', repeat: true },
          { key: 'caption', type: 'text' },
        ],
      },
    });
    const oneImage = {
      ref: {
        $type: 'blob',
        ref: {
          $link: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
        },
        mimeType: 'image/jpeg',
        size: 10,
      },
      alt: 'one',
    };
    // The imported media section holds an array here; a single object is not it.
    expect(
      Schema.is(schema)({
        primary: { images: [oneImage, { ...oneImage, alt: 'two' }] },
      }),
    ).toBe(true);
    expect(Schema.is(schema)({ primary: { images: oneImage } })).toBe(false);
    expect(
      Schema.is(schema)({
        primary: { images: [], caption: 'a repeating field may be empty' },
      }),
    ).toBe(true);
  });

  it('validates a repeating group in the global type', () => {
    const data = dataSchemaForType({ type: globalType });
    expect(
      Schema.is(data)({
        navigation: [{ page: { url: 'https://example.com' } }],
      }),
    ).toBe(true);
    const dec = Schema.decodeUnknownSync(data);
    expect(() => dec({ navigation: { page: {} } })).toThrow();
  });
});

describe('grilling decisions', () => {
  it('accepts a document with an offloaded body blob and its blob mirror', () => {
    const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
    const withBlob = {
      ...sampleDocument,
      body: [],
      bodyBlob: {
        $type: 'blob',
        ref: { $link: cid },
        mimeType: 'application/json',
        size: 1234,
      },
      blobs: [
        {
          $type: 'blob',
          ref: { $link: cid },
          mimeType: 'image/jpeg',
          size: 99,
        },
      ],
    };
    expect(Schema.is(DocumentSchema)(withBlob)).toBe(true);
  });

  it('enforces a zone allowed-slices list for known slices only', () => {
    const data = dataSchemaForType({
      type: {
        ...pageType,
        fields: [
          {
            key: 'slices',
            type: 'sections',
            allowedSections: ['media'],
            maxSections: 2,
          },
        ],
      },
      ctx: { knownSections: ['media', 'relations'] },
    });
    const dec = Schema.decodeUnknownSync(data);
    expect(() =>
      dec({ slices: [{ sectionType: 'media', variation: 'default' }] }),
    ).not.toThrow();
    expect(() =>
      dec({ slices: [{ sectionType: 'relations', variation: 'default' }] }),
    ).toThrow();
    expect(() =>
      dec({ slices: [{ sectionType: 'com.acme.slice', variation: 'x' }] }),
    ).not.toThrow();
    expect(() =>
      dec({
        slices: [
          { sectionType: 'media', variation: 'default' },
          { sectionType: 'media', variation: 'default' },
          { sectionType: 'media', variation: 'default' },
        ],
      }),
    ).toThrow();
  });
});
