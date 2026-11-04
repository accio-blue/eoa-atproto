import { CI_RUN_NSID, type CiRun } from './model.js';

/** A finished run, as the DO and the tests both write it. */
export const sampleRun: CiRun = {
  $type: CI_RUN_NSID,
  repo: 'effects-of-atmosphere',
  repoId: 'did:web:pds.lexicon.ing:repo:effects-of-atmosphere',
  ref: 'refs/heads/land',
  target: '034affdc1b2c4d5e6f708192a3b4c5d6e7f80912',
  before: '2c5e1a0b9d8c7e6f5a4b3c2d1e0f9a8b7c6d5e4f',
  status: 'done',
  outcome: 'passed',
  exitCode: 0,
  log: 'ok 23 tests',
  createdAt: '2026-11-04T09:00:00.000Z',
  endedAt: '2026-11-04T09:01:12.000Z',
};

/** A run that is still waiting, which is the other half of the record's shape. */
export const sampleQueued: CiRun = {
  $type: CI_RUN_NSID,
  repo: 'effects-of-atmosphere',
  repoId: 'did:web:pds.lexicon.ing:repo:effects-of-atmosphere',
  ref: 'refs/heads/land',
  target: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
  status: 'queued',
  createdAt: '2026-11-04T10:00:00.000Z',
};
