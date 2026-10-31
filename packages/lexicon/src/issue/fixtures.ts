import {
  ISSUE_COMMENT_NSID,
  ISSUE_LABEL_NSID,
  ISSUE_LABEL_OP_NSID,
  ISSUE_NSID,
  ISSUE_STATE_NSID,
} from './model.js';

// One sample per record, as a PDS would hold them: the drift test decodes these through the schemas
// *and* walks them against the JSON, so a field added to one and not the other cannot pass.

const subject = {
  uri: 'at://did:web:pds.lexicon.ing:abc123/ing.lexicon.issue/3jzfgg5jfgs2k',
  cid: 'bafyreidfayvfuwqa4xokwj2gmwzdsv4v5w5ndp7zq2qk5v2n5w2w5w5w5w4',
};

const label = {
  uri: 'at://did:web:pds.lexicon.ing:abc123/ing.lexicon.issue.label/3jzfgg5jfgs2m',
  cid: 'bafyreidfayvfuwqa4xokwj2gmwzdsv4v5w5ndp7zq2qk5v2n5w2w5w5w5w4',
};

export const sampleIssue = {
  $type: ISSUE_NSID,
  title: 'The issues surface',
  body: 'Records first, then the machine, then the UI.',
  createdAt: '2026-10-13T15:00:00.000Z',
};

export const sampleState = {
  $type: ISSUE_STATE_NSID,
  subject,
  state: 'in-progress',
  reason: 'The spec is written; the lexicons are next.',
  createdAt: '2026-10-13T15:10:00.000Z',
};

export const sampleComment = {
  $type: ISSUE_COMMENT_NSID,
  subject,
  text: 'Blocked on the machine being generated first.',
  createdAt: '2026-10-13T15:20:00.000Z',
};

export const sampleLabel = {
  $type: ISSUE_LABEL_NSID,
  name: 'protocol',
  color: 'accent',
  description: 'Touches the network or the wire.',
  createdAt: '2026-10-13T15:00:00.000Z',
};

export const sampleLabelOp = {
  $type: ISSUE_LABEL_OP_NSID,
  subject,
  label,
  op: 'add',
  createdAt: '2026-10-13T15:30:00.000Z',
};
