import {
  MERGE_REQUEST_NSID,
  MERGE_REQUEST_STATE_NSID,
  type MergeRequest,
  type MergeStateRecord,
} from './merge-request.js';

const CID = 'bafyreimergerequest';

/** A request, as a person opened it. */
export const sampleMergeRequest: MergeRequest = {
  $type: MERGE_REQUEST_NSID,
  repoId: 'did:web:pds.lexicon.ing:repo:effects-of-atmosphere',
  source: 'refs/heads/ui/dev-console',
  target: 'refs/heads/main',
  title: 'The dev console reads CI runs',
  body: 'Two commits: the run record and the pane that lists it.',
  createdAt: '2026-11-04T09:00:00.000Z',
};

export const sampleMergeUri = `at://did:web:pds.lexicon.ing/${MERGE_REQUEST_NSID}/3jzfgg5jfgs2m`;

/** The change that landed it. */
export const sampleMerged: MergeStateRecord = {
  $type: MERGE_REQUEST_STATE_NSID,
  subject: { uri: sampleMergeUri, cid: CID },
  state: 'merged',
  mergeCommit: 'e6e29e6f1a2b3c4d5e6f708192a3b4c5d6e7f809',
  createdAt: '2026-11-04T11:00:00.000Z',
};

/** A request somebody closed without landing. */
export const sampleClosed: MergeStateRecord = {
  $type: MERGE_REQUEST_STATE_NSID,
  subject: {
    uri: `at://did:web:pds.lexicon.ing/${MERGE_REQUEST_NSID}/3jzfgg5jfgs2q`,
    cid: CID,
  },
  state: 'closed',
  reason: 'Superseded by the branch that landed first.',
  createdAt: '2026-11-04T12:00:00.000Z',
};
