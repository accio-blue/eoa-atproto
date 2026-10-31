/**
 * The atproto NSID syntax, in one place.
 *
 * The domain authority allows hyphens; the name (last) segment does not.
 * https://atproto.com/specs/nsid
 *
 * `nsid.test.ts` is the tripwire for the namespace root; this is the tripwire
 * for the shape. A published lexicon's NSID can never change, so a string that
 * is about to become one is worth checking against a single definition rather
 * than against a copy per call site.
 */
export const NSID_PATTERN =
  /^[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(\.[a-zA-Z]([a-zA-Z0-9]{0,62})?)$/;

/** True when the value is a syntactically valid NSID. */
export const isNsid = (value: unknown): value is string =>
  typeof value === 'string' && NSID_PATTERN.test(value);
