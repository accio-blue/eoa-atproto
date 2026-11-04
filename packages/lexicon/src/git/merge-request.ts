import { Schema } from 'effect';

import { StrongRefSchema } from '../cms/defs.js';

// Hand-typed from `lexicons/ing/lexicon/git/mergeRequest*.json`; the test walks the JSON against the
// fixture so the two cannot drift. Two records, the same shape the tracker uses: the request, and its
// state as an appended log — a merge request's history is what happened to it.

export const MERGE_REQUEST_NSID = 'ing.lexicon.git.mergeRequest';
export const MERGE_REQUEST_STATE_NSID = 'ing.lexicon.git.mergeRequest.state';

/** `open` is the machine's start: there may be no state record at all. */
export const MERGE_STATES = ['open', 'merged', 'closed'] as const;
export type MergeState = (typeof MERGE_STATES)[number];

export { StrongRefSchema };

export const MergeRequestSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(MERGE_REQUEST_NSID)),
  repoId: Schema.String,
  source: Schema.String,
  target: Schema.String,
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
});
export type MergeRequest = typeof MergeRequestSchema.Type;

export const MergeStateSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(MERGE_REQUEST_STATE_NSID)),
  subject: StrongRefSchema,
  state: Schema.Union(MERGE_STATES.map((one) => Schema.Literal(one))),
  mergeCommit: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
});
export type MergeStateRecord = typeof MergeStateSchema.Type;
