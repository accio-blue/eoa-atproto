/**
 * The grant oracle: whether one subject may act on another's thing.
 *
 * `packages/specs/shared/auth.qnt` is the decision and this is its runtime, conjunct for
 * conjunct: `canAct = isActive(grant) and subjectMatchesViewer and verbPermitted(verb) and
 * selectorMatches and not(expired)`.
 *
 * Every one of those is a **denial** when it fails, which is the whole shape of it: an
 * absent grant, a revoked one, a mismatched subject, a verb the grant does not carry and an
 * expired one all refuse. Fail-closed is not a policy this applies — it is what the
 * conjunction does, and keeping the spec's vocabulary is what keeps the two statements of
 * it the same statement.
 *
 * It exists because a calendar asked it. A free/busy answer is the case that made it
 * matter: "nothing is scheduled" and "you may not look" are different answers, and a client
 * that cannot tell them apart draws the first one.
 */
export type GrantState = 'none' | 'active' | 'revoked';

/** What a grant carries: who it is about, what it covers, which verbs, and until when. */
export interface Grant {
  readonly state: GrantState;
  /** Who it is about — a person, a service, a team. */
  readonly subject: string;
  /** What it covers: a space, a calendar, a mailbox. */
  readonly selector: string;
  readonly verbs: ReadonlyArray<'view' | 'write'>;
  /** When it stops applying, ISO 8601 — or nothing for no end. */
  readonly until?: string | undefined;
}

/** The five conjuncts, and nothing else. */
export const canAct = (params: {
  readonly grant: Grant;
  readonly subjectMatchesViewer: boolean;
  readonly verb: 'view' | 'write';
  readonly selectorMatches: boolean;
  readonly now: Date;
}) =>
  params.grant.state === 'active' &&
  params.subjectMatchesViewer &&
  params.grant.verbs.includes(params.verb) &&
  params.selectorMatches &&
  (params.grant.until === undefined ||
    params.grant.until > params.now.toISOString());

/** The spec's `canView`, which is `canAct` with the verb the spec names for it. */
export const canView = (params: {
  readonly grant: Grant;
  readonly subjectMatchesViewer: boolean;
  readonly selectorMatches: boolean;
  readonly now: Date;
}) => canAct({ ...params, verb: 'view' });

export const canWrite = (params: {
  readonly grant: Grant;
  readonly subjectMatchesViewer: boolean;
  readonly selectorMatches: boolean;
  readonly now: Date;
}) => canAct({ ...params, verb: 'write' });

/**
 * Whether *any* grant lets this viewer see this selector.
 *
 * `some` rather than a lookup, because a grant set has no order and no precedence: a viewer
 * either holds something that covers the action or does not. The spec models one grant's
 * lifecycle; a deployment holds a set, and the answer over a set is the answer over any
 * member.
 */
export const canViewOf = (params: {
  readonly grants: ReadonlyArray<Grant>;
  readonly viewer: string;
  readonly selector: string;
  readonly now: Date;
}) =>
  params.grants.some((grant) =>
    canView({
      grant,
      subjectMatchesViewer: grant.subject === params.viewer,
      selectorMatches: grant.selector === params.selector,
      now: params.now,
    }),
  );
