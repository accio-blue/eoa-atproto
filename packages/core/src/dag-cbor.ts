import { type Cid, cidBytes, cidFromBytes } from './cid.js';
import { Data, Result, Schema } from 'effect';

/**
 * DAG-CBOR encoding (the IPLD restricted subset of CBOR), as used by `did:plc`
 * operations and, later, atproto repos.
 *
 * The canonical form matters more than the bytes: `prev` links, the DID itself
 * and every signature are hashes (or signatures) over this encoding, so two
 * encoders that disagree on map-key order produce two identities for one
 * operation. Maps are therefore written in canonical order - shortest key
 * first, then bytewise - and every length argument uses the smallest header.
 *
 * Deliberate narrowings, each failing loudly rather than guessing:
 *
 * - numbers must be SAFE INTEGERS. atproto's data model forbids floats, so we
 *   do not emit float64; a non-integer is a bug, not a value to encode.
 * - `undefined` is rejected. A key must be omitted, never present-and-undefined:
 *   silently dropping it would change the hash of an operation.
 * - bytes are supported (major type 2), and CID links (tag 42) are encoded as
 *   `CidLink`; a PLC `prev` is still a CID *string*, because that is what the
 *   PLC spec says, while a repo block links to its children with real links.
 * - the decoder rejects anything the encoder cannot produce: floats,
 *   indefinite lengths, unknown tags, integers outside the safe range.
 */

const MAJOR_UNSIGNED_INTEGER = 0;
const MAJOR_NEGATIVE_INTEGER = 1;
const MAJOR_BYTE_STRING = 2;
const MAJOR_TEXT_STRING = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;

/** Additional-information codes that say "the length follows". */
const ARGUMENT_UINT8 = 24;
const ARGUMENT_UINT16 = 25;
const ARGUMENT_UINT32 = 26;
const ARGUMENT_UINT64 = 27;

/** IPLD's tag for a CID link. */
const TAG_CID = 42;
const TAG_CID_HEADER = Uint8Array.from([0xd8, 0x2a]);
/** A CID link's payload is the CID's bytes behind a zero byte. */
const CID_LINK_PREFIX = 0;

const SIMPLE_FALSE = 0xf4;
const SIMPLE_TRUE = 0xf5;
const SIMPLE_NULL = 0xf6;
const SIMPLE_FALSE_CODE = 20;
const SIMPLE_TRUE_CODE = 21;
const SIMPLE_NULL_CODE = 22;

/** Lengths below this ride inside the header's additional-information bits. */
const INLINE_ARGUMENT_LIMIT = 24n;
const UINT8_LIMIT = 0x100n;
const UINT16_LIMIT = 0x10000n;
const UINT32_LIMIT = 0x100000000n;
const UINT64_LIMIT = 0x10000000000000000n;

const BYTE_BITS = 8n;
const BYTE_MASK = 0xffn;

const TEXT_ENCODER = new TextEncoder();
const EMPTY_BYTES = new Uint8Array(0);

/**
 * Every value this encoder accepts. A PLC operation is a map of strings,
 * arrays, nested maps and `null`; integers and bytes are here because atproto
 * records need them.
 */
export type CborValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | CidLink
  | CborValue[]
  | { readonly [key: string]: CborValue };

/**
 * An IPLD link: a CID embedded in DAG-CBOR as tag 42. A class rather than a
 * bare object so the encoder can recognise it without inspecting its shape -
 * a plain `{ cid }` would be ambiguous with a map that happens to have that key.
 */
export class CidLink extends Data.TaggedClass('CidLink')<{
  readonly cid: Cid;
}> {}

/** The JSON value domain, as the schema module defines it. */
export type Json = Schema.Schema.Type<typeof Schema.Json>;

/**
 * A JSON value as a CBOR value. The same value, in the encoder's domain.
 *
 * A conversion rather than a union of the two types, because the two really do
 * differ: JSON's arrays are readonly and `CborValue`'s are not, and TypeScript
 * will not narrow a readonly array out of a union when `Array.isArray` says no.
 * Copying the arrays is the honest price of the boundary - and the copy is
 * shallow, so a record costs one array per array it holds.
 */
// Recursive, so TypeScript cannot infer the return type (TS7023); the
// annotation is required here, not stylistic.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
export function asCborValue(value: Json): CborValue {
  if (Array.isArray(value)) {
    return value.map((entry) => asCborValue(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asCborValue(entry)]),
    );
  }
  return value;
}

/** Reported when bytes are not valid DAG-CBOR in the supported subset. */
export class CborDecodeError extends Data.TaggedError('CborDecodeError')<{
  readonly message: string;
}> {}

/** Reported when a value cannot be encoded as DAG-CBOR. */
export class CborEncodeError extends Data.TaggedError('CborEncodeError')<{
  readonly message: string;
}> {}

const bigEndianBytes = (params: { width: number; value: bigint }) =>
  Uint8Array.from({ length: params.width }, (_unused, index) =>
    Number(
      (params.value >> (BYTE_BITS * BigInt(params.width - 1 - index))) &
        BYTE_MASK,
    ),
  );

/**
 * Concatenate byte chunks. Exported because a CAR is bytes too, and one
 * implementation of this beats two.
 */
export const concatBytes = (chunks: ReadonlyArray<Uint8Array>) => {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  chunks.reduce((offset, chunk) => {
    output.set(chunk, offset);
    return offset + chunk.length;
  }, 0);
  return output;
};

const encodeArgument = (argument: bigint) => {
  if (argument < INLINE_ARGUMENT_LIMIT) {
    return { additional: Number(argument), payload: EMPTY_BYTES };
  }
  if (argument < UINT8_LIMIT) {
    return {
      additional: ARGUMENT_UINT8,
      payload: bigEndianBytes({ width: 1, value: argument }),
    };
  }
  if (argument < UINT16_LIMIT) {
    return {
      additional: ARGUMENT_UINT16,
      payload: bigEndianBytes({ width: 2, value: argument }),
    };
  }
  if (argument < UINT32_LIMIT) {
    return {
      additional: ARGUMENT_UINT32,
      payload: bigEndianBytes({ width: 4, value: argument }),
    };
  }
  if (argument < UINT64_LIMIT) {
    return {
      additional: ARGUMENT_UINT64,
      payload: bigEndianBytes({ width: 8, value: argument }),
    };
  }
  throw new CborEncodeError({
    message: `length ${argument} exceeds the 64-bit CBOR argument range`,
  });
};

const encodeHeader = (params: { major: number; argument: bigint }) => {
  const { additional, payload } = encodeArgument(params.argument);
  return concatBytes([
    Uint8Array.from([(params.major << 5) | additional]),
    payload,
  ]);
};

const encodeNumber = (value: number) => {
  if (!Number.isSafeInteger(value)) {
    throw new CborEncodeError({
      message: `expected a safe integer, got ${value}`,
    });
  }
  return value < 0
    ? encodeHeader({
        major: MAJOR_NEGATIVE_INTEGER,
        argument: BigInt(-value) - 1n,
      })
    : encodeHeader({ major: MAJOR_UNSIGNED_INTEGER, argument: BigInt(value) });
};

const encodeBytes = (value: Uint8Array) =>
  concatBytes([
    encodeHeader({ major: MAJOR_BYTE_STRING, argument: BigInt(value.length) }),
    value,
  ]);

/** A CID link: tag 42 over the CID's bytes behind a zero byte. */
const encodeCidLink = (link: CidLink) =>
  concatBytes([
    TAG_CID_HEADER,
    encodeBytes(Uint8Array.from([CID_LINK_PREFIX, ...cidBytes(link.cid)])),
  ]);

const encodeText = (value: string) => {
  const bytes = TEXT_ENCODER.encode(value);
  return concatBytes([
    encodeHeader({ major: MAJOR_TEXT_STRING, argument: BigInt(bytes.length) }),
    bytes,
  ]);
};

const compareBytes = (params: { left: Uint8Array; right: Uint8Array }) => {
  const shared = Math.min(params.left.length, params.right.length);
  const differing = Array.from(
    { length: shared },
    (_unused, index) => index,
  ).find((index) => params.left[index] !== params.right[index]);

  if (differing === undefined) {
    return params.left.length - params.right.length;
  }
  return (params.left[differing] ?? 0) - (params.right[differing] ?? 0);
};

/** Canonical DAG-CBOR map order: shortest UTF-8 key first, then bytewise. */
const canonicalKeys = (record: { readonly [key: string]: CborValue }) =>
  Object.keys(record)
    .map((key) => ({ key, encoded: TEXT_ENCODER.encode(key) }))
    .sort(
      (left, right) =>
        left.encoded.length - right.encoded.length ||
        compareBytes({ left: left.encoded, right: right.encoded }),
    )
    .map((entry) => entry.key);

const encodeArray = (values: ReadonlyArray<CborValue>) =>
  concatBytes([
    encodeHeader({ major: MAJOR_ARRAY, argument: BigInt(values.length) }),
    ...values.map((entry) => encodeValue(entry)),
  ]);

const encodeMap = (record: { readonly [key: string]: CborValue }) => {
  const keys = canonicalKeys(record);
  return concatBytes([
    encodeHeader({ major: MAJOR_MAP, argument: BigInt(keys.length) }),
    ...keys.flatMap((key) => [encodeText(key), encodeValue(record[key])]),
  ]);
};

// Mutually recursive with encodeArray/encodeMap, so TypeScript cannot infer the
// return type (TS7023); the annotation is required here, not stylistic.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
const encodeValue = (value: CborValue): Uint8Array => {
  if (value === undefined) {
    throw new CborEncodeError({
      message: 'undefined is not encodable; omit the key instead',
    });
  }
  if (value === null) {
    return Uint8Array.from([SIMPLE_NULL]);
  }
  if (typeof value === 'boolean') {
    return Uint8Array.from([value ? SIMPLE_TRUE : SIMPLE_FALSE]);
  }
  if (typeof value === 'number') {
    return encodeNumber(value);
  }
  if (typeof value === 'string') {
    return encodeText(value);
  }
  if (value instanceof CidLink) {
    return encodeCidLink(value);
  }
  if (value instanceof Uint8Array) {
    return encodeBytes(value);
  }
  if (Array.isArray(value)) {
    return encodeArray(value);
  }
  return encodeMap(value);
};

/** Encodes a value as canonical DAG-CBOR. */
export const encodeCbor = (value: CborValue) => encodeValue(value);

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

type DecodedItem = {
  readonly value: CborValue;
  readonly next: number;
};

const TEXT_DECODER = new TextDecoder();

const requireBytes = (params: {
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly length: number;
}) => {
  if (params.offset + params.length > params.bytes.length) {
    throw new CborDecodeError({
      message: `truncated: wanted ${params.length} bytes at ${params.offset}, ${params.bytes.length - params.offset} remain`,
    });
  }
};

const decodeArgument = (params: {
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly additional: number;
}) => {
  if (params.additional < Number(INLINE_ARGUMENT_LIMIT)) {
    return { argument: BigInt(params.additional), next: params.offset };
  }

  const width =
    params.additional === ARGUMENT_UINT8
      ? 1
      : params.additional === ARGUMENT_UINT16
        ? 2
        : params.additional === ARGUMENT_UINT32
          ? 4
          : params.additional === ARGUMENT_UINT64
            ? 8
            : 0;
  if (width === 0) {
    throw new CborDecodeError({
      message: `unsupported additional information ${params.additional}`,
    });
  }

  requireBytes({ bytes: params.bytes, offset: params.offset, length: width });
  const argument = Array.from({ length: width }, (_unused, index) =>
    BigInt(params.bytes[params.offset + index] ?? 0),
  ).reduce((accumulator, byte) => (accumulator << BYTE_BITS) | byte, 0n);

  return { argument, next: params.offset + width };
};

const decodeItems = (params: {
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly count: number;
}) => {
  const values: CborValue[] = [];
  const next = Array.from({ length: params.count }).reduce<number>((offset) => {
    const decoded = decodeAt(params.bytes, offset);
    values.push(decoded.value);
    return decoded.next;
  }, params.offset);
  return { values, next };
};

const decodeEntries = (params: {
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly count: number;
}) => {
  const entries: { [key: string]: CborValue } = {};
  const next = Array.from({ length: params.count }).reduce<number>((offset) => {
    const key = decodeAt(params.bytes, offset);
    if (typeof key.value !== 'string') {
      throw new CborDecodeError({ message: 'map keys must be strings' });
    }
    const entry = decodeAt(params.bytes, key.next);
    entries[key.value] = entry.value;
    return entry.next;
  }, params.offset);
  return { entries, next };
};

const decodeCidLink = (params: {
  readonly bytes: Uint8Array;
  readonly offset: number;
}) => {
  const payload = decodeAt(params.bytes, params.offset);
  if (!(payload.value instanceof Uint8Array)) {
    throw new CborDecodeError({ message: 'a CID link must be a byte string' });
  }
  if (payload.value.at(0) !== CID_LINK_PREFIX) {
    throw new CborDecodeError({
      message: 'a CID link must start with a zero byte',
    });
  }

  const cid = cidFromBytes(payload.value.slice(1));
  if (Result.isFailure(cid)) {
    throw new CborDecodeError({ message: cid.failure.message });
  }

  return { value: new CidLink({ cid: cid.success }), next: payload.next };
};

const decodeInteger = (params: {
  readonly value: bigint;
  readonly negative: boolean;
}) => {
  const value = Number(params.negative ? -1n - params.value : params.value);
  if (!Number.isSafeInteger(value)) {
    throw new CborDecodeError({
      message: `integer ${params.value} is outside the safe range`,
    });
  }
  return value;
};

// Recursive, so TypeScript cannot infer the return type (TS7023); the
// annotation is required here, not stylistic.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
const decodeAt = (bytes: Uint8Array, offset: number): DecodedItem => {
  requireBytes({ bytes, offset, length: 1 });
  const initial = bytes[offset] ?? 0;
  const major = initial >> 5;
  const additional = initial & 0x1f;
  const { argument, next } = decodeArgument({
    bytes,
    offset: offset + 1,
    additional,
  });
  const length = Number(argument);

  switch (major) {
    case MAJOR_UNSIGNED_INTEGER:
      return {
        value: decodeInteger({ value: argument, negative: false }),
        next,
      };
    case MAJOR_NEGATIVE_INTEGER:
      return {
        value: decodeInteger({ value: argument, negative: true }),
        next,
      };
    case MAJOR_BYTE_STRING: {
      requireBytes({ bytes, offset: next, length });
      return { value: bytes.slice(next, next + length), next: next + length };
    }
    case MAJOR_TEXT_STRING: {
      requireBytes({ bytes, offset: next, length });
      return {
        value: TEXT_DECODER.decode(bytes.slice(next, next + length)),
        next: next + length,
      };
    }
    case MAJOR_ARRAY: {
      const decoded = decodeItems({ bytes, offset: next, count: length });
      return { value: decoded.values, next: decoded.next };
    }
    case MAJOR_MAP: {
      const decoded = decodeEntries({ bytes, offset: next, count: length });
      return { value: decoded.entries, next: decoded.next };
    }
    case MAJOR_TAG: {
      if (argument !== BigInt(TAG_CID)) {
        throw new CborDecodeError({ message: `unsupported tag ${argument}` });
      }
      return decodeCidLink({ bytes, offset: next });
    }
    default: {
      if (additional === SIMPLE_FALSE_CODE) {
        return { value: false, next };
      }
      if (additional === SIMPLE_TRUE_CODE) {
        return { value: true, next };
      }
      if (additional === SIMPLE_NULL_CODE) {
        return { value: null, next };
      }
      throw new CborDecodeError({
        message: `unsupported simple value ${additional}`,
      });
    }
  }
};

/** Decodes DAG-CBOR into the value domain the encoder accepts. */
export const decodeCbor = (bytes: Uint8Array) => {
  const decoded = decodeAt(bytes, 0);
  if (decoded.next !== bytes.length) {
    throw new CborDecodeError({
      message: `${bytes.length - decoded.next} trailing bytes`,
    });
  }
  return decoded.value;
};
