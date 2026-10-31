import { Context, Effect, Layer } from 'effect';
import {
  gateLookup,
  gateSetExpired,
  gateSetGrant,
  gateSetSelectorOk,
  gateSetSubjectMatchesViewer,
  gateSetVisibility,
  idleGate,
  visibilityGateStep,
} from './visibility-gate.js';
import { IndexStore } from './index-store.js';

/**
 * The backlink read: "who references this subject?", answered only as far as
 * the subject's visibility allows.
 *
 * The gate decides, and this only obeys it. A `visible` subject's sources come
 * from the index store; a `hidden` or unresolved subject yields no sources at
 * all - not even a count, because a hidden subject must not leak that anything
 * references it. The gate runs from `idleGate()` through the same facts a
 * lookup carries, so the answer is the spec's, not a second opinion.
 */

export interface LookupShape {
  /**
   * The sources referencing a subject, when the subject's visibility lets this
   * viewer see them. `visible` carries the sources; `hidden` carries none; an
   * unresolved subject is `none`.
   */
  readonly backlinks: (params: {
    readonly target: string;
    readonly visibility: string; // "none" | "public" | "private"
    readonly grant: string; // "none" | "active" | "revoked"
    readonly subjectMatchesViewer: boolean;
    readonly selectorOk: boolean;
    readonly expired: boolean;
  }) => Effect.Effect<{
    readonly decision: 'visible' | 'hidden' | 'none';
    readonly sources: readonly string[];
  }>;
}

export class BacklinkLookup extends Context.Service<
  BacklinkLookup,
  LookupShape
>()('@eoa/appview/BacklinkLookup') {}

type LookupParams = Parameters<LookupShape['backlinks']>[0];

/** The gate's answer to this lookup: every fact in, then `lookup`. */
function gateDecision(params: LookupParams) {
  const withVisibility = visibilityGateStep({
    fields: idleGate(),
    event: gateSetVisibility({ v: params.visibility }),
  });
  const withGrant = visibilityGateStep({
    fields: withVisibility,
    event: gateSetGrant({ g: params.grant }),
  });
  const withMatch = visibilityGateStep({
    fields: withGrant,
    event: gateSetSubjectMatchesViewer({
      matches: params.subjectMatchesViewer,
    }),
  });
  const withSelector = visibilityGateStep({
    fields: withMatch,
    event: gateSetSelectorOk({ ok: params.selectorOk }),
  });
  const withExpiry = visibilityGateStep({
    fields: withSelector,
    event: gateSetExpired({ expired: params.expired }),
  });
  const resolved = visibilityGateStep({
    fields: withExpiry,
    event: gateLookup(),
  });

  if (resolved.decision === 'visible') {
    return 'visible';
  }
  if (resolved.decision === 'hidden') {
    return 'hidden';
  }
  return 'none';
}

/**
 * The read over the index store. The gate runs first; only a `visible` decision
 * is allowed to touch the store, so a hidden subject cannot leak its backlinks
 * through a count or a read.
 */
export const backlinkLookupLayer: Layer.Layer<
  BacklinkLookup,
  never,
  IndexStore
> = Layer.effect(
  BacklinkLookup,
  Effect.gen(function* () {
    const store = yield* IndexStore;

    return {
      backlinks: (params) =>
        Effect.gen(function* () {
          const decision = gateDecision(params);

          if (decision !== 'visible') {
            return { decision, sources: [] };
          }

          return {
            decision,
            sources: yield* store.backlinksOf(params.target),
          };
        }),
    } satisfies LookupShape;
  }),
);
