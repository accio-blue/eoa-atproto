import { Schema } from 'effect';

// Common schema utilities for AT Protocol

// Blob schema for binary data
export const BlobSchema = Schema.Struct({
  $type: Schema.Literal('blob'),
  ref: Schema.Struct({
    $link: Schema.String,
  }),
  mimeType: Schema.String,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});

// CID schema for content identifiers
export const CIDSchema = Schema.String.check(
  Schema.isPattern(/^bafy[a-zA-Z0-9]{55}$/),
);

// DateTime schema for AT Protocol timestamps
export const DateTimeSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/),
);

// Language tag schema
export const LanguageTagSchema = Schema.String.check(
  Schema.isPattern(/^[a-z]{2,3}(-[A-Z]{2})?$/),
);

// AT Protocol record schema base
export const RecordSchema = Schema.Struct({
  $type: Schema.String,
  createdAt: DateTimeSchema,
});
