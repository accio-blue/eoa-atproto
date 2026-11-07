import { Condition, FieldPath } from './grant.js';
import { DID } from '@eoa/core';
import { Schema } from 'effect';

/**
 * `ing.lexicon.lens` — a shared projection, stored in the authority's repo in the space.
 *
 * A lens is what a view of one record shape returns: a list of JSON Pointer paths, optionally a
 * condition. It exists because a grant's own `fields` are private to that grant: two grants that
 * promise the same view would each have to write the same list, and nothing would say they agreed.
 * The lens is that agreement, versioned (its cid) and public (a record in the space).
 *
 * The record's **key is the NSID of the shape it applies to**, which is what makes the existing
 * `LensRef { nsid, cid }` a reference to it: the nsid selects the record, the cid pins the version.
 * A cid that no longer matches is `incompatible` and the grant fails closed — a projection is a
 * promise about what a reader sees, and a silently changed one is a different promise.
 */
export const LENS_NSID = 'ing.lexicon.lens';

export const Lens = Schema.Struct({
  fields: Schema.NonEmptyArray(FieldPath),
  condition: Schema.optionalKey(Condition),
  description: Schema.optionalKey(Schema.String),
  issuedBy: DID,
  createdAt: Schema.DateTimeUtcFromString,
});
export type Lens = typeof Lens.Type;

/** Decoded strictly: a lens with a key nobody modelled is a refusal, not a silent narrowing. */
export const decodeLens = Schema.decodeUnknownEffect(Lens, {
  onExcessProperty: 'error',
});
