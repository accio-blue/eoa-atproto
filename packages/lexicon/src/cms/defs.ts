import { BlobSchema } from '../schema.js';
import { Schema } from 'effect';

// Hand-typed from lexicons/ing/lexicon/cms/defs.json; the lexicon test walks the
// JSON against samples so the two cannot drift silently.

/** The field kinds a content type or slice variation is built from. */
export const FIELD_KINDS = [
  'uid',
  'text',
  'richText',
  'image',
  'link',
  'embed',
  'number',
  'boolean',
  'date',
  'timestamp',
  'select',
  'color',
  'group',
  'sections',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** An image field's expected dimensions (Prismic `constraint`). */
export interface ImageConstraint {
  readonly width?: number;
  readonly height?: number;
}
export const ImageConstraintSchema = Schema.Struct({
  width: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  height: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});

/**
 * One field in a content type or a slice variation. `type` is the field kind;
 * the other properties are that kind's options. A group nests its own fields, so
 * a type is a tree.
 */
export interface FieldDef {
  readonly key: string;
  readonly type: FieldKind;
  readonly label?: string;
  readonly placeholder?: string;
  readonly tab?: string;
  readonly required?: boolean;
  readonly repeat?: boolean;
  readonly fields?: ReadonlyArray<FieldDef>;
  readonly single?: string;
  readonly multi?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly select?: string;
  readonly customtypes?: ReadonlyArray<string>;
  readonly values?: ReadonlyArray<string>;
  readonly constraint?: ImageConstraint;
  /** slices: the slice keys this zone allows (known-but-other fails; unknown passes). */
  readonly allowedSections?: ReadonlyArray<string>;
  readonly minSections?: number;
  readonly maxSections?: number;
  readonly maxDepth?: number;
}

export const FieldDefSchema: Schema.Codec<FieldDef> = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literals(FIELD_KINDS),
  label: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  tab: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
  repeat: Schema.optionalKey(Schema.Boolean),
  fields: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<FieldDef> => FieldDefSchema)),
  ),
  single: Schema.optionalKey(Schema.String),
  multi: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  select: Schema.optionalKey(Schema.String),
  customtypes: Schema.optionalKey(Schema.Array(Schema.String)),
  values: Schema.optionalKey(Schema.Array(Schema.String)),
  constraint: Schema.optionalKey(ImageConstraintSchema),
  allowedSections: Schema.optionalKey(Schema.Array(Schema.String)),
  minSections: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  maxSections: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  maxDepth: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});

/** A stable reference to a record: its at-uri and the cid it was read at. */
export interface StrongRef {
  readonly uri: string;
  readonly cid: string;
}
export const StrongRefSchema = Schema.Struct({
  uri: Schema.String.check(Schema.isMinLength(1)),
  cid: Schema.String.check(Schema.isMinLength(1)),
});

/**
 * A slice instance in a document's body. `primary` is one field set; `items` is
 * the slice's repeatable list. Both are validated against the slice model.
 */
export type SectionEntry = {
  readonly id?: string;
  readonly sectionType: string;
  readonly variation: string;
  readonly version?: string;
  readonly label?: string;
  readonly primary?: { readonly [key: string]: Schema.Json };
  readonly items?: ReadonlyArray<{ readonly [key: string]: Schema.Json }>;
};
export const SectionEntrySchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  sectionType: Schema.String.check(Schema.isMinLength(1)),
  variation: Schema.String.check(Schema.isMinLength(1)),
  version: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  primary: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  items: Schema.optionalKey(
    Schema.Array(Schema.Record(Schema.String, Schema.Json)),
  ),
});

/**
 * Portable Text (https://portabletext.org): a document's rich-text value. Kept
 * permissive — a block is any object carrying a string `_type`, because custom
 * block types are the point — so this checks structure, not a closed vocabulary.
 */
export const PortableTextSchema = Schema.Array(
  Schema.Record(Schema.String, Schema.Json).check(
    Schema.makeFilter((block) =>
      typeof block['_type'] === 'string'
        ? []
        : ['a portable text block needs a string _type'],
    ),
  ),
);
export type PortableText = typeof PortableTextSchema.Type;

/**
 * One resized copy of an image: what a reader picks from a `srcset`.
 *
 * A variant names the size it is *for*, and either where the bytes are (`url`)
 * or the blob itself (`ref`). The width is required, because a copy whose size is
 * unknown is not a variant — it is just another image.
 */
export const ImageVariantSchema = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  url: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(BlobSchema),
});
export type ImageVariant = typeof ImageVariantSchema.Type;

/**
 * An image value: the blob plus the presentation metadata a reader needs.
 *
 * `variants` is where a site's resized copies live (kocharin keeps them in a
 * bucket behind `img.kocharin.art`), and the colour/placeholder fields are what
 * paint the box before the bytes arrive — the same set Grain carries on its own
 * photo records, beside the picture rather than inside it.
 */
export const ImageValueSchema = Schema.Struct({
  ref: BlobSchema,
  url: Schema.optionalKey(Schema.String),
  alt: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  height: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The colour the box behind the image is painted with, as hex. */
  dominantColor: Schema.optionalKey(Schema.String),
  palette: Schema.optionalKey(Schema.Array(Schema.String)),
  thumbhash: Schema.optionalKey(Schema.String),
  /** The resized copies a `srcset` chooses from, smallest first. */
  variants: Schema.optionalKey(Schema.Array(ImageVariantSchema)),
  /**
   * What the camera wrote about the picture, when it wrote anything.
   *
   * Grain keeps this *beside* the photo, in a `social.grain.photo.exif` record
   * keyed by the photo's at-uri (`make`, `model`, `lensMake`, `lensModel`,
   * `focalLengthIn35mmFormat`, `flash`, …). The value is left open rather than
   * closed to a list this model would then have to keep up with: EXIF is the
   * camera's vocabulary, not ours, and a closed schema would drop the fields it
   * does not know.
   */
  exif: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  /**
   * The sidecar this image's derived data lives in, when it does.
   *
   * A picture that appears in many documents and locales should carry its
   * palette and its placeholder **once**, in an `ing.lexicon.cms.image` record
   * — facts about the picture, not about a page, and the part most likely to be
   * recomputed. Inline fields above stay for an image that has no sidecar: a
   * value that keeps everything is the simple case, and a link is the one that
   * scales.
   */
  meta: Schema.optionalKey(StrongRefSchema),
});
export type ImageValue = typeof ImageValueSchema.Type;

/** A link value: a document reference, an external url, or both. */
export const LinkValueSchema = Schema.Struct({
  ref: Schema.optionalKey(StrongRefSchema),
  url: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
});
export type LinkValue = typeof LinkValueSchema.Type;

/** An embed value: a provider url with its optional oEmbed html. */
export const EmbedValueSchema = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
});
export type EmbedValue = typeof EmbedValueSchema.Type;
