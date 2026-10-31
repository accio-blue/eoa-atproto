import { Data, Match } from 'effect';

/**
 * Visibility follows the subject, against the spec
 * (`packages/specs/specs/backlink-index/visibility-gate.qnt`).
 *
 * A backlink lookup asks "who references this subject?", and the answer is
 * gated by the *subject's* visibility, not the backlink's: a public subject's
 * backlinks are visible to everyone, a private subject's only to a holder of an
 * active grant, and an unresolved subject yields no decision at all.
 *
 * The decision is the shared oracle's - flat, positive-only, fail-closed - so
 * every condition has to hold, and an absent, revoked, mismatched or expired
 * grant denies. The oracle is mirrored here because the space host that owns
 * grants (0.3) does not exist yet; when it does, this should ask it rather than
 * agree with it.
 */

/** The gate's fields, as the spec declares them. */
export type VisibilityGateFields = {
  readonly visibility: string;
  readonly grant: string;
  readonly subjectMatchesViewer: boolean;
  readonly selectorOk: boolean;
  readonly expired: boolean;
  /** A lookup is pending. */
  readonly requested: boolean;
  readonly decision: string;
};

/** The shared oracle, mirrored: every condition must hold, or it denies. */
export const canView = (params: {
  readonly grant: string;
  readonly subjectMatchesViewer: boolean;
  readonly selectorOk: boolean;
  readonly expired: boolean;
}) =>
  params.grant === 'active' &&
  params.subjectMatchesViewer &&
  params.selectorOk &&
  !params.expired;

/** A gate with nothing resolved and nothing decided. */
export const idleGate = () => ({
  visibility: 'none',
  grant: 'none',
  subjectMatchesViewer: false,
  selectorOk: false,
  expired: false,
  requested: false,
  decision: 'none',
});

/** The spec's events, as constructors. */
type VisibilityGateEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly setVisibility: { readonly v: string };
  readonly setGrant: { readonly g: string };
  readonly setSubjectMatchesViewer: { readonly matches: boolean };
  readonly setSelectorOk: { readonly ok: boolean };
  readonly setExpired: { readonly expired: boolean };
  readonly lookup: {};
}>;

export const {
  init: gateInit,
  setVisibility: gateSetVisibility,
  setGrant: gateSetGrant,
  setSubjectMatchesViewer: gateSetSubjectMatchesViewer,
  setSelectorOk: gateSetSelectorOk,
  setExpired: gateSetExpired,
  lookup: gateLookup,
} = Data.taggedEnum<VisibilityGateEventMap>();

/** The decision a resolved subject gets. */
const decisionFor = (fields: VisibilityGateFields) => {
  if (fields.visibility === 'none') {
    return 'none';
  }
  if (fields.visibility === 'public') {
    return 'visible';
  }

  return canView({
    grant: fields.grant,
    subjectMatchesViewer: fields.subjectMatchesViewer,
    selectorOk: fields.selectorOk,
    expired: fields.expired,
  })
    ? 'visible'
    : 'hidden';
};

/** One step of the spec's `step` action, exhaustive over its events. */
export const visibilityGateStep = (params: {
  readonly fields: VisibilityGateFields;
  readonly event: VisibilityGateEventMap;
}) => {
  const { fields, event } = params;

  // Every fact a lookup depends on resets the decision: a stale answer must not
  // survive the fact it was made from.
  const refactored = (change: Partial<VisibilityGateFields>) => ({
    ...fields,
    ...change,
    requested: false,
    decision: 'none',
  });

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleGate(),

      setVisibility: ({ v }) => refactored({ visibility: v }),
      setGrant: ({ g }) => refactored({ grant: g }),
      setSubjectMatchesViewer: ({ matches }) =>
        refactored({ subjectMatchesViewer: matches }),
      setSelectorOk: ({ ok }) => refactored({ selectorOk: ok }),
      setExpired: ({ expired }) => refactored({ expired }),

      lookup: () => ({
        ...fields,
        requested: true,
        decision: decisionFor(fields),
      }),
    }),
  );
};
