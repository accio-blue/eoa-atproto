import type { CustomSection, CustomType } from './model.js';
import type { Document } from './document.js';
import type { SectionEntry } from './defs.js';

// Fixtures mirroring orchestra-next's Prismic model (customtypes/page,
// customtypes/global, slices/media) — the first migration target. The lexicon
// test decodes them against the hand-typed schemas.

export const pageType: CustomType = {
  $type: 'ing.lexicon.cms.type',
  key: 'page',
  name: 'Page',
  kind: 'repeatable',
  meta: {
    title: 'meta_title',
    description: 'meta_description',
    image: 'meta_image',
  },
  fields: [
    { key: 'uid', type: 'uid', label: 'UID' },
    { key: 'title', type: 'richText', label: 'Title', single: 'heading1' },
    { key: 'slices', type: 'sections', label: 'Slice Zone' },
    {
      key: 'meta_title',
      type: 'text',
      label: 'Meta Title',
      tab: 'SEO & Metadata',
    },
    {
      key: 'meta_description',
      type: 'text',
      label: 'Meta Description',
      tab: 'SEO & Metadata',
    },
    {
      key: 'meta_image',
      type: 'image',
      label: 'Meta Image',
      tab: 'SEO & Metadata',
      constraint: { width: 2400, height: 1260 },
    },
  ],
};

export const globalType: CustomType = {
  $type: 'ing.lexicon.cms.type',
  key: 'global',
  name: 'Global',
  kind: 'singleton',
  fields: [
    {
      key: 'navigation',
      type: 'group',
      label: 'Navigation',
      repeat: true,
      fields: [
        {
          key: 'page',
          type: 'link',
          label: 'Page',
          select: 'document',
          customtypes: ['page'],
        },
      ],
    },
    { key: 'slices', type: 'sections', label: 'Slice Zone' },
    {
      key: 'all_projects',
      type: 'text',
      label: 'All Projects',
      tab: 'Translations',
    },
    { key: 'services', type: 'text', label: 'Services', tab: 'Translations' },
  ],
};

export const mediaSection: CustomSection = {
  $type: 'ing.lexicon.cms.section',
  key: 'media',
  name: 'Media',
  variations: [
    {
      id: 'default',
      name: 'Default',
      primary: [
        {
          key: 'media',
          type: 'group',
          label: 'Media',
          repeat: true,
          fields: [{ key: 'image', type: 'image', label: 'Image' }],
        },
      ],
    },
    {
      id: 'mediaWithText',
      name: 'Media – With Text',
      primary: [
        {
          key: 'text',
          type: 'richText',
          label: 'Text',
          multi: 'paragraph,strong,em,hyperlink',
        },
        {
          key: 'media',
          type: 'group',
          label: 'Media',
          repeat: true,
          fields: [{ key: 'image', type: 'image', label: 'Image' }],
        },
      ],
    },
  ],
};

const BLOB_CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const image = (size: number) => ({
  ref: {
    $type: 'blob' as const,
    ref: { $link: BLOB_CID },
    mimeType: 'image/jpeg',
    size,
  },
});

export const sampleSectionEntry: SectionEntry = {
  sectionType: 'media',
  variation: 'default',
  primary: { media: [{ image: image(4321) }] },
};

export const sampleDocument: Document = {
  $type: 'ing.lexicon.cms.document',
  type: 'page',
  uid: 'home',
  lang: 'ru',
  tags: ['home'],
  data: {
    title: [
      {
        _type: 'block',
        _key: 'b1',
        style: 'heading1',
        children: [{ _type: 'span', _key: 's1', text: 'Оркестр', marks: [] }],
      },
    ],
    meta_title: 'Оркестр',
    meta_description: 'Домашняя страница',
    meta_image: { ...image(12345), alt: 'Оркестр', width: 2400, height: 1260 },
  },
  body: [sampleSectionEntry],
  createdAt: '2026-10-12T00:00:00.000Z',
  publishedAt: '2026-10-12T00:00:00.000Z',
};
