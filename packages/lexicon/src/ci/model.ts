import { Schema } from 'effect';

// Hand-typed from `lexicons/ing/lexicon/ci/run.json`; the test walks the JSON against the fixture so
// the two cannot drift silently. One record, because a run is a snapshot: the queue writes it at the
// push and replaces it at the end (the description says why that is not a log).

export const CI_RUN_NSID = 'ing.lexicon.ci.run';

/** Where the machine is. `done` is over; `outcome` says how. */
export const CI_STATUSES = ['queued', 'running', 'done'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

/** How a finished run ended: the command's verdict, or the run never getting to run. */
export const CI_OUTCOMES = ['passed', 'failed', 'error'] as const;
export type CiOutcome = (typeof CI_OUTCOMES)[number];

export const CiRunSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(CI_RUN_NSID)),
  repo: Schema.String,
  repoId: Schema.String,
  ref: Schema.String,
  target: Schema.String,
  before: Schema.optionalKey(Schema.String),
  status: Schema.Union(CI_STATUSES.map((one) => Schema.Literal(one))),
  outcome: Schema.optionalKey(
    Schema.Union(CI_OUTCOMES.map((one) => Schema.Literal(one))),
  ),
  exitCode: Schema.optionalKey(Schema.Int),
  log: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  endedAt: Schema.optionalKey(Schema.String),
});
export type CiRun = typeof CiRunSchema.Type;

/**
 * The outcome a run has, from what the DO recorded.
 *
 * The machine does not write an outcome it has not earned: a run that never got a container or a
 * token is `error` (not `failed` — the commit did not fail, the CI did), and only a command's own
 * exit code decides between `passed` and `failed`.
 */
export interface OutcomeInput {
  readonly status: CiStatus;
  readonly exitCode: number | undefined;
  /** The run never got to run: no container, no token, no session. */
  readonly refused: boolean;
}

export const outcomeOf = ({
  status,
  exitCode,
  refused,
}: OutcomeInput): CiOutcome | undefined => {
  if (status !== 'done') {
    return undefined;
  }
  if (refused || exitCode === undefined) {
    return 'error';
  }
  return exitCode === 0 ? 'passed' : 'failed';
};
