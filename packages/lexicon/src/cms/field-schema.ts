import type { CustomType, SectionVariation } from './model.js';
import {
  EmbedValueSchema,
  ImageValueSchema,
  LinkValueSchema,
  PortableTextSchema,
  SectionEntrySchema,
} from './defs.js';
import type { FieldDef } from './defs.js';
import { Schema } from 'effect';

// The bridge from a runtime type record to the Effect Schema that validates a
// document's `data`. The model is data, so the schema is built when the type is
// read — there is no lexicon per type. Validation only; the encoded value still
// lives inside the lexicon's open `data`.

/** Slices nest, so a zone has a depth ceiling (`fieldDef.maxDepth` is bounded by this). */
export const MAX_SECTION_DEPTH = 8;

/** What the builder needs beyond the type itself. */
export interface SchemaContext {
  /** Every slice key the site defines, so "known but disallowed" is detectable. */
  readonly knownSections?: ReadonlyArray<string>;
}

const isKnownSection = ({
  ctx,
  sectionType,
}: {
  readonly ctx: SchemaContext;
  readonly sectionType: string;
}): boolean => (ctx.knownSections ?? []).includes(sectionType);

const allowsSection = ({
  field,
  ctx,
  sectionType,
}: {
  readonly field: FieldDef;
  readonly ctx: SchemaContext;
  readonly sectionType: string;
}): boolean => {
  const allowed = field.allowedSections;
  if (allowed === undefined || allowed.includes(sectionType)) {
    return true;
  }
  // Unknown slice keys always pass (round-trip rule); known-but-other fails.
  return !isKnownSection({ ctx, sectionType });
};

/** A `slices` zone: length bounds plus the allowed-slice rule. */
const zoneSchema = ({
  field,
  ctx,
}: {
  readonly field: FieldDef;
  readonly ctx: SchemaContext;
}) =>
  Schema.Array(SectionEntrySchema).check(
    Schema.makeFilter((entries) => {
      const issues: string[] = [];
      if (
        field.minSections !== undefined &&
        entries.length < field.minSections
      ) {
        issues.push(
          `zone needs at least ${field.minSections} slice(s), has ${entries.length}`,
        );
      }
      if (
        field.maxSections !== undefined &&
        entries.length > field.maxSections
      ) {
        issues.push(
          `zone allows at most ${field.maxSections} slice(s), has ${entries.length}`,
        );
      }
      for (const entry of entries) {
        if (!allowsSection({ field, ctx, sectionType: entry.sectionType })) {
          issues.push(
            `slice "${entry.sectionType}" is not allowed in this zone`,
          );
        }
      }
      return issues;
    }),
  );

/** Rich text that may embed slices: a known slice key must look like a sectionEntry. */
const portableTextField = ({
  field,
  ctx,
}: {
  readonly field: FieldDef;
  readonly ctx: SchemaContext;
}) =>
  PortableTextSchema.check(
    Schema.makeFilter((blocks) => {
      const issues: string[] = [];
      for (const block of blocks) {
        const type = block['_type'];
        if (
          typeof type !== 'string' ||
          !isKnownSection({ ctx, sectionType: type })
        ) {
          continue;
        }
        if (typeof block['variation'] !== 'string') {
          issues.push(`embedded slice "${type}" needs a variation`);
        }
        if (!allowsSection({ field, ctx, sectionType: type })) {
          issues.push(`slice "${type}" is not allowed in this rich text`);
        }
      }
      return issues;
    }),
  );

/** The value schema for one field, by kind. */
function kindSchema({
  field,
  ctx,
}: {
  readonly field: FieldDef;
  readonly ctx: SchemaContext;
}) {
  switch (field.type) {
    case 'number':
      return Schema.Number;
    case 'boolean':
      return Schema.Boolean;
    case 'richText':
      return portableTextField({ field, ctx });
    case 'image':
      return ImageValueSchema;
    case 'link':
      return LinkValueSchema;
    case 'embed':
      return EmbedValueSchema;
    case 'group':
      return objectOf({ fields: field.fields ?? [], ctx });
    case 'sections':
      return zoneSchema({ field, ctx });
    default:
      // text, uid, date, timestamp, select, color — all strings.
      return Schema.String;
  }
}

/**
 * The value schema for one field: its kind, repeated when the field says so.
 *
 * `repeat` is the model's word for "many", and it applies to every kind, not only
 * `group`. The imported Prismic groups are exactly this: a `media` section whose
 * `images` field is `type: 'image', repeat: true` and whose records hold an array
 * of images. Honouring `repeat` for groups alone made every such entry invalid.
 */
function valueSchema({
  field,
  ctx,
}: {
  readonly field: FieldDef;
  readonly ctx: SchemaContext;
}) {
  const one = kindSchema({ field, ctx });
  return field.repeat === true ? Schema.Array(one) : one;
}

/** An object schema with one optional key per field. */
function objectOf({
  fields,
  ctx,
}: {
  readonly fields: ReadonlyArray<FieldDef>;
  readonly ctx: SchemaContext;
}): Schema.Codec<unknown> {
  // `required` is a claim the schema has to keep, or it is decoration: a field
  // that says it is required is a key without `optionalKey`, so a partial draft
  // is refused where the draft is not partial. Everything else stays optional —
  // a draft is allowed to be missing what it has not written yet.
  return Schema.Struct(
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        field.required === true
          ? valueSchema({ field, ctx })
          : Schema.optionalKey(valueSchema({ field, ctx })),
      ]),
    ),
  );
}

/** The `data` schema for a content type. */
export const dataSchemaForType = ({
  type,
  ctx = {},
}: {
  readonly type: CustomType;
  readonly ctx?: SchemaContext;
}) => objectOf({ fields: type.fields, ctx });

/** The value schema for a slice variation: `primary` plus repeatable `items`. */
export const sectionSchemaForVariation = ({
  variation,
  ctx = {},
}: {
  readonly variation: SectionVariation;
  readonly ctx?: SchemaContext;
}) =>
  Schema.Struct({
    primary: objectOf({ fields: variation.primary, ctx }),
    items: Schema.optionalKey(
      Schema.Array(objectOf({ fields: variation.items ?? [], ctx })),
    ),
  });
