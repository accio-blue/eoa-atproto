import { type ImageVariant, ImageVariantSchema } from './defs.js';
import { BlobSchema } from '../schema.js';
import { Schema } from 'effect';

// Hand-typed from lexicons/ing/lexicon/cms/image.json; the record keeps the
// image's bytes and everything derived from them, so a document can point at it
// instead of repeating a palette in every locale.
//
// Why a record at all: a picture can appear in many documents, and its palette
// and placeholder are facts about the picture, not about any one page. It is
// also the part most likely to be recomputed — a sidecar can be rewritten
// without touching a document.

export const IMAGE_NSID = 'ing.lexicon.cms.image';

export { ImageVariantSchema, type ImageVariant };

export const ImageRecordSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(IMAGE_NSID)),
  ref: BlobSchema,
  width: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  height: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  dominantColor: Schema.optionalKey(Schema.String),
  palette: Schema.optionalKey(Schema.Array(Schema.String)),
  thumbhash: Schema.optionalKey(Schema.String),
  variants: Schema.optionalKey(Schema.Array(ImageVariantSchema)),
  createdAt: Schema.String,
  updatedAt: Schema.optionalKey(Schema.String),
});
export type ImageRecord = typeof ImageRecordSchema.Type;
