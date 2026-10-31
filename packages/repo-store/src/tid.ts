import { Effect } from 'effect';

/**
 * A TID: the revision a repo commit carries.
 *
 * Thirteen characters of base32-sortable, so that sorting them as strings is
 * sorting them as time — which is what lets a client tell which of two commits
 * is later without a clock of its own. The value is microseconds since the
 * epoch shifted left ten bits, with a clock id in the low bits so two writes in
 * the same microsecond still differ.
 */
const ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

const LENGTH = 13;

const CLOCK_BITS = 10n;

const CLOCK_MASK = (1n << CLOCK_BITS) - 1n;

/** The format, for readers of a revision that came from somewhere else. */
export const isTid = (value: string) =>
  value.length === LENGTH &&
  Array.from(value).every((character) => ALPHABET.includes(character));

export const encodeTid = (params: {
  readonly micros: number;
  readonly clockId: number;
}) => {
  const value =
    (BigInt(Math.floor(params.micros)) << CLOCK_BITS) |
    (BigInt(params.clockId) & CLOCK_MASK);

  return Array.from(
    { length: LENGTH },
    (_unused, index) =>
      ALPHABET[Number((value >> BigInt(5 * (LENGTH - 1 - index))) & 31n)] ??
      '2',
  ).join('');
};

/**
 * A revision for a write happening now. The clock id comes from the caller —
 * a node that writes twice in one microsecond must still produce two revisions,
 * and only the caller knows what its clock looks like.
 */
export const nextTid = (params: {
  readonly now: number;
  readonly clockId: number;
}) =>
  Effect.sync(() =>
    encodeTid({ micros: params.now * 1000, clockId: params.clockId }),
  );
