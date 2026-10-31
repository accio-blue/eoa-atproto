/**
 * `ing.lexicon.ui.component` — a component implementation, and the resolution
 * that turns a component NSID into the implementation a host should use.
 *
 * Inlay's model (github.com/danabra/inlay), under our namespace: the record
 * key IS the NSID the component implements, and a component carries an ordered
 * **DID import stack**. For each NSID, the first DID in the stack that
 * publishes it wins. The tenant supplies the default order; a component's own
 * `imports` override it for that component's subtree.
 *
 * Deny-by-default: a DID that is not in the order is not a candidate, so a
 * repository the host has not been told to trust cannot win by publishing the
 * name. A missing NSID resolves to `undefined` — the host's fallback is its own
 * business.
 *
 * Behaviour is never in the record (no chart, no script): a record carries the
 * body (a remote call or a template tree) and the view contract, and the code
 * lives in the host or the plugin's own bundle.
 */
import type { Schema } from 'effect';

export const COMPONENT_NSID = 'ing.lexicon.ui.component';

export const EXTERNAL_BODY = 'ing.lexicon.ui.component#bodyExternal';
export const TEMPLATE_BODY = 'ing.lexicon.ui.component#bodyTemplate';

export interface ExternalBody {
  readonly $type: typeof EXTERNAL_BODY;
  /** DID of the service hosting the component. */
  readonly did: string;
  /** Send a signed JWT identifying the viewer with each call. */
  readonly personalized?: boolean;
}

export interface TemplateBody {
  readonly $type: typeof TEMPLATE_BODY;
  /** Serialized element tree with bindings; opaque to this module. */
  readonly node: Schema.Json;
}

export type ComponentBody = ExternalBody | TemplateBody;

export interface RecordView {
  readonly $type?: string;
  /** Omit for any collection. */
  readonly collection?: string;
  /** Baked record key; present enables DID expansion. */
  readonly rkey?: string;
}

export interface PrimitiveView {
  readonly $type?: string;
  readonly type: string;
  readonly format?: string;
}

export interface ComponentView {
  /** Which component prop receives the view data. */
  readonly prop: string;
  readonly accepts: readonly (RecordView | PrimitiveView)[];
}

export interface ComponentRecord {
  readonly $type: typeof COMPONENT_NSID;
  /** The NSID this component implements (the record key). */
  readonly nsid: string;
  readonly imports: readonly string[];
  readonly body?: ComponentBody;
  readonly view?: ComponentView;
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

/** A component record together with the repository that publishes it. */
export interface PublishedComponent {
  readonly did: string;
  readonly record: ComponentRecord;
}

export interface ResolutionOrderForParams {
  readonly record: Pick<ComponentRecord, 'imports'> | undefined;
  readonly tenantOrder: readonly string[];
}

/** The order to resolve in: a tenant default, or a component's own imports. */
export const resolutionOrderFor = ({
  record,
  tenantOrder,
}: ResolutionOrderForParams): readonly string[] =>
  record !== undefined && record.imports.length > 0
    ? record.imports
    : tenantOrder;

export interface ResolveComponentParams {
  readonly nsid: string;
  readonly published: readonly PublishedComponent[];
  readonly order: readonly string[];
}

/**
 * The first publisher of `nsid` in `order`, or `undefined` when nobody in the
 * order publishes it. `published` is what the host actually loaded, so a
 * candidate outside `order` is ignored rather than trusted.
 *
 * Two records from the same DID for the same NSID is invalid (a repo has one
 * record per rkey, and the rkey is the NSID) and is rejected loudly rather than
 * resolved by picking one.
 */
export const resolveComponent = ({
  nsid,
  published,
  order,
}: ResolveComponentParams): PublishedComponent | undefined => {
  const seen = new Set<string>();
  for (const candidate of published) {
    if (candidate.record.$type !== COMPONENT_NSID) continue;
    if (candidate.record.nsid !== nsid) continue;
    if (seen.has(candidate.did)) {
      throw new Error(
        `two ${COMPONENT_NSID} records from ${candidate.did} implement ${nsid}`,
      );
    }
    seen.add(candidate.did);
  }
  for (const did of order) {
    const winner = published.find(
      (candidate) =>
        candidate.did === did &&
        candidate.record.$type === COMPONENT_NSID &&
        candidate.record.nsid === nsid,
    );
    if (winner !== undefined) {
      return winner;
    }
  }
  return undefined;
};
