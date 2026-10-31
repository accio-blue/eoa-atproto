/**
 * `ing.lexicon.ui.component#bodyTemplate` — the serialized element tree.
 *
 * The lexicon declares `node` as `type: "unknown"` (TypeScript types it
 * `Schema.Json`), so a record another DID wrote can carry anything at all. What
 * it must carry is the rule `effects-of-atmosphere-nx46` decided: a template is
 * **data only** — an element tree of `{ key?, type, props? }`, where `type` is
 * an NSID, `key` is a string, and every prop is JSON data or, for `children`,
 * more elements. No functions, no class instances, no cycles.
 *
 * `nonDataNodes` is the check a host runs on a record it did not write, in the
 * style of `unknownIntents`: pure, sorted, deduplicated — empty means the tree
 * is clean. It returns the *paths* of the offending values rather than a bare
 * boolean, so a host can say which node in whose record is not data.
 *
 * An `at.inlay.component` record, if a converter ever turns one into our shape,
 * is the same tree and wants the same check; nothing converts one today, so
 * there is nothing to wire it to yet.
 */
import { Predicate, Schema } from 'effect';
import { isNsid } from '../nsid.js';

/**
 * `Schema.Json` is exactly "data": null, boolean, string, a finite number, an
 * array or a plain object of those — and it returns false for a cycle, so a
 * prop cannot smuggle a reference back into the tree.
 */
const isData = Schema.is(Schema.Json);

/** A JSON object: not an array, and not an instance of somebody's class. */
const isPlainObject = <T extends object>(value: T): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

/** One step of the walk: the value to check, and where it sits in the tree. */
interface WalkStep {
  readonly value: unknown;
  readonly path: string;
}

/** One prop of a node: its name and value, plus the node's path for reporting. */
interface PropStep {
  readonly path: string;
  readonly name: string;
  readonly prop: unknown;
}

/**
 * The paths of the values under `node` that are not data-only, sorted and
 * deduplicated. `$` is the root; `$.props.children[0].props.onClick` is a
 * function on a child's prop; `$.props.children[1]` is a child that is not an
 * element. An empty array means the tree is a valid template.
 */
// The input's provenance is unknown by definition — this function *is* the
// boundary check the rule wants callers to run first, so `unknown` is the
// honest parameter type rather than a parsed one.
// oxlint-disable-next-line automation/no-unknown-parameters
export const nonDataNodes = (node: unknown): readonly string[] => {
  const offenders = new Set<string>();
  /** The objects on the current path, so a cycle is reported, not recursed. */
  const onPath = new WeakSet<object>();

  const walkProp = ({ path, name, prop }: PropStep): void => {
    const pathTo = `${path}.props.${name}`;
    if (name !== 'children') {
      if (!isData(prop)) {
        offenders.add(pathTo);
      }
      return;
    }
    if (!Array.isArray(prop)) {
      offenders.add(pathTo);
      return;
    }
    prop.forEach((child, index) => {
      walkElement({ value: child, path: `${pathTo}[${index}]` });
    });
  };

  const walkElement = ({ value, path }: WalkStep): void => {
    // A non-object, a class instance or a reference back up the tree: not data.
    if (
      !Predicate.isObjectOrArray(value) ||
      Array.isArray(value) ||
      !isPlainObject(value) ||
      onPath.has(value)
    ) {
      offenders.add(path);
      return;
    }
    onPath.add(value);

    if (!isNsid(value.type)) {
      offenders.add(`${path}.type`);
    }
    if (value.key !== undefined && typeof value.key !== 'string') {
      offenders.add(`${path}.key`);
    }

    const props = value.props;
    if (props === undefined) {
      onPath.delete(value);
      return;
    }
    if (
      !Predicate.isObjectOrArray(props) ||
      Array.isArray(props) ||
      !isPlainObject(props)
    ) {
      offenders.add(`${path}.props`);
    } else {
      for (const [name, prop] of Object.entries(props)) {
        walkProp({ path, name, prop });
      }
    }

    onPath.delete(value);
  };

  walkElement({ value: node, path: '$' });
  return [...offenders].sort();
};
