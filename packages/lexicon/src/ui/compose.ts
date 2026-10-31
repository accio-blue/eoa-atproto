/**
 * Composition: resolving a whole element tree, not one name.
 *
 * An element is Inlay's: `{ key?, type, props? }`, with child elements under
 * `props.children`. Each `type` is an NSID resolved through the DID import
 * stack ([resolveComponent](./component.ts)) — and a resolved component's own
 * `imports` become the order for **its subtree**, which is what makes
 * composition local: a component can pin the dependency it wants without
 * changing how anything else resolves.
 *
 * Nothing here throws for a name that does not resolve, and nothing hides one
 * either: an unresolved NSID is reported in `unresolved` and the node simply
 * carries no `resolved`, so the host can fall back to a built-in primitive, a
 * placeholder, or an error surface of its own choosing. A depth cap reports
 * `truncated` rather than recursing forever.
 */
import {
  type PublishedComponent,
  resolutionOrderFor,
  resolveComponent,
} from './component.js';
import { Predicate } from 'effect';

/** An element to render: Inlay-shaped, children under `props.children`. */
export interface Element {
  /** Stable key among siblings. */
  readonly key?: string;
  /** The NSID this element is an instance of. */
  readonly type: string;
  /** Opaque to this module — a component's props are Inlay's, not ours. */
  readonly props?: ElementProps;
}

/** Only `children` is read; what else a component takes is its own business. */
export interface ElementProps {
  /** Filtered to elements on read — anything else in the array is ignored. */
  readonly children?: readonly unknown[];
}

export interface ResolvedNode {
  readonly element: Element;
  /** Absent when nobody in the effective order publishes `element.type`. */
  readonly resolved?: PublishedComponent;
  readonly children: readonly ResolvedNode[];
}

export interface Composition {
  readonly roots: readonly ResolvedNode[];
  /** Every NSID that did not resolve, deduplicated and sorted. */
  readonly unresolved: readonly string[];
  /** The depth cap was hit; the tree below that point is not walked. */
  readonly truncated: boolean;
}

export interface CompositionOptions {
  /** Guard against a pathological tree. Defaults to 64. */
  readonly maxDepth?: number;
}

const isElement = (value: unknown): value is Element =>
  Predicate.isObjectOrArray(value) &&
  Predicate.hasProperty(value, 'type') &&
  typeof value.type === 'string';

const childrenOf = (element: Element): readonly Element[] => {
  const children = element.props?.children;
  return Array.isArray(children) ? children.filter(isElement) : [];
};

export interface ResolveCompositionParams {
  readonly roots: readonly Element[];
  readonly published: readonly PublishedComponent[];
  readonly tenantOrder: readonly string[];
  readonly options?: CompositionOptions;
}

/**
 * Resolve every element in `roots` against the publishers the host loaded,
 * carrying each component's own import order down to its children.
 */
export const resolveComposition = ({
  roots,
  published,
  tenantOrder,
  options = {},
}: ResolveCompositionParams): Composition => {
  const maxDepth = options.maxDepth ?? 64;
  const unresolved = new Set<string>();
  let truncated = false;

  const walk = ({
    element,
    order,
    depth,
  }: {
    readonly element: Element;
    readonly order: readonly string[];
    readonly depth: number;
  }): ResolvedNode => {
    const resolved = resolveComponent({
      nsid: element.type,
      published,
      order,
    });
    if (resolved === undefined) {
      unresolved.add(element.type);
    }
    const base = resolved === undefined ? { element } : { element, resolved };
    if (depth >= maxDepth) {
      truncated = true;
      return { ...base, children: [] };
    }
    const childOrder = resolutionOrderFor({
      record: resolved?.record,
      tenantOrder: order,
    });
    return {
      ...base,
      children: childrenOf(element).map((child) =>
        walk({ element: child, order: childOrder, depth: depth + 1 }),
      ),
    };
  };

  return {
    roots: roots.map((root) =>
      walk({ element: root, order: tenantOrder, depth: 0 }),
    ),
    unresolved: [...unresolved].sort(),
    truncated,
  };
};
