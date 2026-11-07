import { Schema } from 'effect';

/**
 * A record cut down to the fields a grant promised (`n6lg`).
 *
 * A selector's `fields` are RFC 6901 JSON Pointers (`/startedAt`, `/data/name`), and the
 * projection is a **filter**, not a promise of presence: a path the record does not have is simply
 * absent from the result, because an optional field that a record legitimately lacks must not make
 * every read of it fail. What the filter does promise is that nothing outside the listed paths
 * survives.
 *
 * `$type` is always kept. A record without it is not the same record to a reader — it cannot be
 * interpreted at all — so no grant is allowed to make one unrecognisable by omitting it.
 */

/** A JSON object, as every record is: the only shape this module walks into. */
type JsonObject = { readonly [key: string]: Schema.Json };

/** One node of the paths being kept: which children are wanted, or "everything here". */
interface Kept {
  readonly all: boolean;
  readonly children: ReadonlyMap<string, Kept>;
}

const WHOLE: Kept = { all: true, children: new Map() };

const tokenOf = (token: string): string =>
  token.replaceAll('~1', '/').replaceAll('~0', '~');

/** The tokens of a JSON Pointer, or `undefined` for a path that is not one. */
const tokensOf = (path: string): ReadonlyArray<string> | undefined =>
  path.startsWith('/') ? path.slice(1).split('/').map(tokenOf) : undefined;

/**
 * Grow the tree of kept paths by one pointer. A path that is not a pointer is ignored rather than
 * guessed at: the decoder refuses one at the record's edge, and a projection must not invent a
 * meaning for what got past it.
 */
const keep = (paths: ReadonlyArray<ReadonlyArray<string>>): Kept => {
  const build = (
    depth: number,
    from: ReadonlyArray<ReadonlyArray<string>>,
  ): Kept => {
    if (from.some((tokens) => tokens.length === depth)) {
      return WHOLE;
    }
    const grouped = new Map<string, Array<ReadonlyArray<string>>>();
    for (const tokens of from) {
      if (tokens.length <= depth) {
        continue;
      }
      const token = tokens[depth] ?? '';
      const list = grouped.get(token) ?? [];
      list.push(tokens);
      grouped.set(token, list);
    }
    const children = new Map<string, Kept>();
    for (const [token, deeper] of grouped) {
      children.set(token, build(depth + 1, deeper));
    }
    return { all: false, children };
  };
  return build(0, paths);
};

const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The value with everything the tree does not keep removed.
 *
 * ponytail: an array is only ever kept whole or dropped — a pointer that walks *into* a list
 * (`/tags/0`) is not traversed, because a sparse projection of a list is a different feature
 * (blinkers has `items` for it). Add it when a lens needs to promise a slice of a list.
 */
const filtered = (value: Schema.Json, kept: Kept): Schema.Json | undefined => {
  if (kept.all) {
    return value;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }
  const out: Record<string, Schema.Json> = {};
  for (const [key, child] of kept.children) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    const keptChild = filtered(value[key] as Schema.Json, child);
    if (keptChild !== undefined) {
      out[key] = keptChild;
    }
  }
  return out;
};

/**
 * The record as a reader with this grant sees it: the listed fields, `$type`, and nothing else.
 *
 * `fields === undefined` means the grant promised no projection, so the record is returned as it
 * is — the same record a reader got before fields existed.
 */
export const projectRecord = (
  record: Schema.Json,
  fields: ReadonlyArray<string> | undefined,
): Schema.Json => {
  if (fields === undefined || !isJsonObject(record)) {
    return record;
  }
  const tokens = fields
    .map(tokensOf)
    .filter((each): each is ReadonlyArray<string> => each !== undefined);
  if (tokens.length === 0) {
    return record;
  }
  const projected = filtered(record, keep([...tokens, ['$type']]));
  // `$type` is not optional: a record a reader cannot interpret is not a narrower view of it.
  const type = record['$type'];
  if (!isJsonObject(projected)) {
    return type === undefined ? {} : { $type: type };
  }
  return type === undefined ? projected : { $type: type, ...projected };
};

/** The value at a JSON Pointer, or `undefined` when any step of it is absent. */
const valueAt = (
  record: JsonObject,
  tokens: ReadonlyArray<string>,
): Schema.Json | undefined => {
  let current: Schema.Json | undefined = record;
  for (const token of tokens) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, token)) {
      return undefined;
    }
    current = current[token];
  }
  return current;
};

/**
 * Whether a record satisfies a grant's condition (`d27l`): the datetime at `condition.field` must be
 * no older than `maxAgeSeconds` at `now`.
 *
 * A missing field, a value that is not a string, and a string that is not a date all fail — a
 * condition that cannot be checked is not satisfied. `now` is passed in rather than read from the
 * clock so a test can place a record on either side of the window.
 */
export const withinWindow = (
  record: Schema.Json,
  condition: { readonly field: string; readonly maxAgeSeconds: number },
  now: number,
): boolean => {
  if (!isJsonObject(record)) {
    return false;
  }
  const tokens = tokensOf(condition.field);
  if (tokens === undefined) {
    return false;
  }
  const value = valueAt(record, tokens);
  if (typeof value !== 'string') {
    return false;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    return false;
  }
  return now - at <= condition.maxAgeSeconds * 1000;
};
