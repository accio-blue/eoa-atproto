import { type CborValue, CidLink } from '@eoa/core';

/**
 * Every AT-URI reference a record's value carries, in encounter order.
 *
 * Lexicon-agnostic on purpose: a reference is a string that starts with
 * "at://", wherever it sits in the value - an object's value, an array entry,
 * or a string in either. Keys are not values, so a key is never a reference.
 *
 * Deduped by the string itself, so a target linked twice is listed once, at
 * the position it was first seen. No cycle guard: a record is decoded
 * DAG-CBOR, which is a finite tree, so a repeated object cannot occur.
 */
export const referencesIn = (record: CborValue) => {
  const found = new Set<string>();

  const walk = (value: CborValue) => {
    if (typeof value === 'string') {
      if (value.startsWith('at://')) {
        found.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    // Numbers, booleans, null and undefined carry no text; bytes and CID
    // links are opaque. Only a map's values remain to walk.
    if (value === null || !(value instanceof Object)) {
      return;
    }
    if (value instanceof Uint8Array || value instanceof CidLink) {
      return;
    }
    Object.values(value).forEach(walk);
  };

  walk(record);

  const references: readonly string[] = [...found];
  return references;
};
