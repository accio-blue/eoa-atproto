import { SectionEntrySchema, StrongRefSchema } from './defs.js';
import { BlobSchema } from '../schema.js';
import { Schema } from 'effect';

// Hand-typed from lexicons/ing/lexicon/cms/{document,draft}.json. A document is
// one per (type, uid, locale); the rkey is `<lang>-<uid>`.

export const DOCUMENT_NSID = 'ing.lexicon.cms.document';
export const DRAFT_NSID = 'ing.lexicon.cms.draft';

// Document and draft are the same record shape in two collections; only the
// `$type` differs, so one factory builds both.
const documentSchema = (nsid: string) =>
  Schema.Struct({
    $type: Schema.optionalKey(Schema.Literal(nsid)),
    type: Schema.String.check(Schema.isMinLength(1)),
    uid: Schema.String.check(Schema.isMinLength(1)),
    lang: Schema.String.check(Schema.isMinLength(2)),
    publication: Schema.optionalKey(Schema.String),
    tags: Schema.optionalKey(Schema.Array(Schema.String)),
    data: Schema.Record(Schema.String, Schema.Json),
    body: Schema.optionalKey(Schema.Array(SectionEntrySchema)),
    alternates: Schema.optionalKey(Schema.Array(StrongRefSchema)),
    bodyBlob: Schema.optionalKey(BlobSchema),
    blobs: Schema.optionalKey(Schema.Array(BlobSchema)),
    publishedAt: Schema.optionalKey(Schema.String),
    createdAt: Schema.String,
    updatedAt: Schema.optionalKey(Schema.String),
  });

export const DocumentSchema = documentSchema(DOCUMENT_NSID);
export const DraftSchema = documentSchema(DRAFT_NSID);
export type Document = typeof DocumentSchema.Type;
export type Draft = typeof DraftSchema.Type;

/** The document's rkey: `<lang>-<uid>`. */
export const documentRkey = (document: {
  readonly lang: string;
  readonly uid: string;
}): string => `${document.lang}-${document.uid}`;
