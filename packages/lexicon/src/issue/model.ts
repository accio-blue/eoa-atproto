import { Schema } from 'effect';
import { StrongRefSchema } from '../cms/defs.js';

// Hand-typed from `lexicons/ing/lexicon/issue/*.json`; the test walks the JSON against the fixtures
// so the two cannot drift silently. The record set is the one `t9gi` settled: an issue, its state
// and comments *as separate records*, and labels as a definition plus an append-only op log.

/** The four states, as the machine knows them (`apps/machine-spike/specs/work.qnt`). */
export const ISSUE_STATES = ['todo', 'in-progress', 'blocked', 'done'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const ISSUE_NSID = 'ing.lexicon.issue';
export const ISSUE_STATE_NSID = 'ing.lexicon.issue.state';
export const ISSUE_COMMENT_NSID = 'ing.lexicon.issue.comment';
export const ISSUE_LABEL_NSID = 'ing.lexicon.issue.label';
export const ISSUE_LABEL_OP_NSID = 'ing.lexicon.issue.labelOp';

/**
 * A reference that survives what it points at being rewritten: uri and cid, not a bare at-uri.
 *
 * **Reused from the CMS rather than redefined here.** It is the same two fields either way, and a
 * second definition of a shared shape is exactly the drift the rest of this package writes tests
 * against. Its NSID is the reason it has to come from a lexicon doc at all: this repo holds every
 * `ref` to the `ing.lexicon.*` namespace, so `com.atproto.repo.strongRef` is not an option.
 */
export { StrongRefSchema };

export const IssueSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(ISSUE_NSID)),
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
});
export type Issue = typeof IssueSchema.Type;

export const IssueStateSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(ISSUE_STATE_NSID)),
  subject: StrongRefSchema,
  state: Schema.Union(ISSUE_STATES.map((one) => Schema.Literal(one))),
  reason: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
});
export type IssueStateRecord = typeof IssueStateSchema.Type;

export const IssueCommentSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(ISSUE_COMMENT_NSID)),
  subject: StrongRefSchema,
  text: Schema.String,
  createdAt: Schema.String,
});
export type IssueComment = typeof IssueCommentSchema.Type;

export const IssueLabelSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(ISSUE_LABEL_NSID)),
  name: Schema.String,
  color: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
});
export type IssueLabel = typeof IssueLabelSchema.Type;

export const IssueLabelOpSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(ISSUE_LABEL_OP_NSID)),
  subject: StrongRefSchema,
  label: StrongRefSchema,
  op: Schema.Union([Schema.Literal('add'), Schema.Literal('remove')]),
  createdAt: Schema.String,
});
export type IssueLabelOp = typeof IssueLabelOpSchema.Type;
