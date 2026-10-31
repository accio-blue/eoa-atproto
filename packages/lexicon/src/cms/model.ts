import { FieldDefSchema } from './defs.js';
import { Schema } from 'effect';

// Hand-typed from lexicons/ing/lexicon/cms/{type,slice}.json. The content MODEL
// is data: a type record says what a document's `data` holds, and a slice record
// says what a body entry's `primary`/`items` hold.

export const CUSTOM_TYPE_NSID = 'ing.lexicon.cms.type';
export const CUSTOM_SECTION_NSID = 'ing.lexicon.cms.section';

export const TYPE_KINDS = ['repeatable', 'singleton'] as const;
export type TypeKind = (typeof TYPE_KINDS)[number];

/** Which field keys supply a document's SEO/meta values. */
export interface MetaMapping {
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
}
const MetaMappingSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
});

/**
 * A content type — Prismic's custom type. `kind` is repeatable or singleton; the
 * `fields` are the type's field tree. The rkey of the record is `key`.
 */
export const CustomTypeSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(CUSTOM_TYPE_NSID)),
  key: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  label: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(TYPE_KINDS),
  meta: Schema.optionalKey(MetaMappingSchema),
  fields: Schema.Array(FieldDefSchema),
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
});
export type CustomType = typeof CustomTypeSchema.Type;

/** One named variation of a slice: its `primary` fields and repeatable `items`. */
export const SectionVariationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  imageUrl: Schema.optionalKey(Schema.String),
  primary: Schema.Array(FieldDefSchema),
  items: Schema.optionalKey(Schema.Array(FieldDefSchema)),
});
export type SectionVariation = typeof SectionVariationSchema.Type;

/** A shared slice — Prismic's shared slice. The rkey of the record is `key`. */
export const CustomSectionSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(CUSTOM_SECTION_NSID)),
  key: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  variations: Schema.Array(SectionVariationSchema),
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
});
export type CustomSection = typeof CustomSectionSchema.Type;
