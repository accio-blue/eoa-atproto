import { Schema } from 'effect';

/**
 * A TID: the sortable identifier that orders an account's writes.
 *
 * Thirteen characters of base32-sortable - eleven digits of microsecond
 * timestamp, then two of clock id - so that sorting the strings sorts the
 * writes, bytewise, with no parser in between.
 *
 * The reference keeps a module-level clock (`lastTimestamp`, `timestampCount`,
 * `clockid`). Here the previous value and the clock id are arguments instead:
 * the clock belongs to the account being written, and a test can pin the time.
 * That also removes the one thing that made the reference's TIDs hard to
 * reason about - hidden state shared by every account in the process.
 */

export const TID_LENGTH = 13;
const TIMESTAMP_DIGITS = 11;
const CLOCK_ID_DIGITS = 2;
/** The base32-sortable alphabet: ASCII order is numeric order. */
const S32_CHAR = '234567abcdefghijklmnopqrstuvwxyz';
const S32_BASE = 32;
/** A microsecond is what a TID counts; milliseconds are what a clock gives. */
const MICROS_PER_MILLI = 1000;
/** Clock ids are five bits. */
export const CLOCK_ID_LIMIT = 32;
/** Eleven base32 digits is the range a timestamp has to stay inside. */
const TIMESTAMP_LIMIT = S32_BASE ** TIMESTAMP_DIGITS;

/** Reported when a value cannot be a TID. */
export class InvalidTidError extends Schema.TaggedError<InvalidTidError>()(
  'InvalidTidError',
  {
    message: Schema.String,
  },
) {}

/** A TID, as it appears in a commit's `rev`. */
export const TID = Schema.String.check(
  Schema.isPattern(new RegExp(`^[${S32_CHAR}]{${TID_LENGTH}}$`)),
).pipe(Schema.brand('TID'));

export type TID = Schema.Schema.Type<typeof TID>;

/** Fixed-width base32-sortable, most significant digit first. */
const s32Encode = (params: {
  readonly value: number;
  readonly width: number;
}) =>
  Array.from({ length: params.width }, (_unused, position) =>
    S32_CHAR.charAt(
      Math.floor(params.value / S32_BASE ** (params.width - 1 - position)) %
        S32_BASE,
    ),
  ).join('');

const s32Decode = (digits: string) =>
  Array.from(digits).reduce(
    (total, digit) => total * S32_BASE + S32_CHAR.indexOf(digit),
    0,
  );

/** The TID for a microsecond timestamp and a clock id. */
export const tidFromTime = (params: {
  readonly timestamp: number;
  readonly clockId: number;
}) => {
  if (
    !Number.isSafeInteger(params.timestamp) ||
    params.timestamp < 0 ||
    params.timestamp >= TIMESTAMP_LIMIT
  ) {
    throw new InvalidTidError({
      message: `timestamp ${params.timestamp} does not fit in ${TIMESTAMP_DIGITS} base32 digits`,
    });
  }
  if (
    !Number.isInteger(params.clockId) ||
    params.clockId < 0 ||
    params.clockId >= CLOCK_ID_LIMIT
  ) {
    throw new InvalidTidError({
      message: `clock id ${params.clockId} is not in [0, ${CLOCK_ID_LIMIT})`,
    });
  }

  return `${s32Encode({ value: params.timestamp, width: TIMESTAMP_DIGITS })}${s32Encode(
    { value: params.clockId, width: CLOCK_ID_DIGITS },
  )}`;
};

/** The microsecond timestamp a TID encodes. */
export const tidTimestamp = (tid: string) =>
  s32Decode(tid.slice(0, TIMESTAMP_DIGITS));

/** The clock id a TID encodes. */
export const tidClockId = (tid: string) =>
  s32Decode(tid.slice(TIMESTAMP_DIGITS));

/**
 * The next TID: strictly newer than `previous`, and never behind `now`.
 *
 * Two writes in the same millisecond still differ, because the previous value
 * is a floor rather than a comparison - which is what makes `rev` order writes
 * even when the clock does not move, or moves backwards.
 */
export const nextTid = (params: {
  readonly previous: string | undefined;
  readonly now: number;
  readonly clockId: number;
}) => {
  const fromNow = Math.floor(params.now * MICROS_PER_MILLI);
  const afterPrevious =
    params.previous === undefined ? 0 : tidTimestamp(params.previous) + 1;

  // The value comes from our own encoder, so this decode cannot fail; it is
  // here to make the brand, exactly as `createDIDKey` does with a DID.
  return Schema.decodeSync(TID)(
    tidFromTime({
      timestamp: Math.max(fromNow, afterPrevious),
      clockId: params.clockId,
    }),
  );
};
