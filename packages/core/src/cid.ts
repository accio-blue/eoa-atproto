import { BASE32_PREFIX, decodeBase32, encodeBase32 } from './multibase.js';
import { Data, Result } from 'effect';

/**
 * CIDv1 in the shape atproto uses: base32 multibase, dag-cbor (`0x71`) or raw
 * (`0x55`) codec, sha2-256 multihash.
 *
 * `prev` in a PLC operation is a CID *string* (the spec says the CID is
 * string-encoded in DAG-CBOR, not a binary link), so this module produces and
 * reads strings rather than building an IPLD block.
 *
 * Deliberate narrowing: version, codec, hash code and digest length are read as
 * single-byte varints, so anything with a multi-byte varint fails loudly. Every
 * CID in atproto is below those limits; a general varint reader is only worth
 * writing when a real value needs one.
 */

/** Multicodec and multihash codes used by this network. */
export const CID_VERSION_1 = 1;
export const CODEC_RAW = 0x55;
export const CODEC_DAG_CBOR = 0x71;
export const MULTIHASH_SHA2_256 = 0x12;

/** A varint whose first byte has the high bit set continues into the next. */
const MULTI_BYTE_VARINT_LIMIT = 0x80;
const SHA2_256_DIGEST_LENGTH = 32;
const HEADER_LENGTH = 4;
const DIGEST_OFFSET = HEADER_LENGTH;

/** A parsed CID: enough to re-encode it and to compare digests. */
export type Cid = {
  readonly version: number;
  readonly codec: number;
  readonly digest: Uint8Array;
};

/** Reported when a string is not a CID this module can represent. */
export class CidError extends Data.TaggedError('CidError')<{
  readonly message: string;
}> {}

/** The CID's binary form: version, codec, multihash code, length, digest. */
export const cidBytes = (cid: Cid) =>
  Uint8Array.from([
    cid.version,
    cid.codec,
    MULTIHASH_SHA2_256,
    cid.digest.length,
    ...cid.digest,
  ]);

/** Builds a CIDv1 (sha2-256) from an already-computed digest. */
export const cidFromDigest = (params: {
  readonly codec: number;
  readonly digest: Uint8Array;
}): Cid => ({
  version: CID_VERSION_1,
  codec: params.codec,
  digest: params.digest,
});

/** The canonical string form: base32 multibase. */
export const formatCid = (cid: Cid) =>
  `${BASE32_PREFIX}${encodeBase32(cidBytes(cid))}`;

/** Parses a CID string, rejecting anything outside the supported subset. */
export const parseCid = (text: string) => {
  if (!text.startsWith(BASE32_PREFIX)) {
    return Result.fail(
      new CidError({
        message: `expected a base32 multibase CID ('b'), got '${text.slice(0, 1)}'`,
      }),
    );
  }

  const decoded = decodeBase32(text.slice(BASE32_PREFIX.length));
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new CidError({
        message: `CID is not valid base32: ${decoded.failure.message}`,
      }),
    );
  }

  const bytes = decoded.success;
  const version = bytes.at(0);
  const codec = bytes.at(1);
  const hashCode = bytes.at(2);
  const digestLength = bytes.at(3);

  if (
    version === undefined ||
    codec === undefined ||
    hashCode === undefined ||
    digestLength === undefined
  ) {
    return Result.fail(
      new CidError({ message: 'CID is shorter than its header' }),
    );
  }
  if (version !== CID_VERSION_1) {
    return Result.fail(
      new CidError({ message: `unsupported CID version ${version}` }),
    );
  }
  if (codec >= MULTI_BYTE_VARINT_LIMIT) {
    return Result.fail(
      new CidError({ message: 'multi-byte codec varints are not supported' }),
    );
  }
  if (hashCode !== MULTIHASH_SHA2_256) {
    return Result.fail(
      new CidError({ message: `unsupported multihash code ${hashCode}` }),
    );
  }
  if (digestLength !== SHA2_256_DIGEST_LENGTH) {
    return Result.fail(
      new CidError({
        message: `unsupported sha2-256 digest length ${digestLength}`,
      }),
    );
  }
  if (bytes.length !== DIGEST_OFFSET + digestLength) {
    return Result.fail(
      new CidError({ message: 'CID length does not match its digest length' }),
    );
  }

  return Result.succeed({
    version,
    codec,
    digest: bytes.slice(DIGEST_OFFSET),
  });
};

/**
 * Parses the binary form of a CID - the form an IPLD link carries. Same
 * narrowing as `parseCid`: single-byte varints, sha2-256 only.
 */
export const cidFromBytes = (bytes: Uint8Array) => {
  const version = bytes.at(0);
  const codec = bytes.at(1);
  const hashCode = bytes.at(2);
  const digestLength = bytes.at(3);

  if (
    version === undefined ||
    codec === undefined ||
    hashCode === undefined ||
    digestLength === undefined
  ) {
    return Result.fail(
      new CidError({ message: 'CID is shorter than its header' }),
    );
  }
  if (version !== CID_VERSION_1) {
    return Result.fail(
      new CidError({ message: `unsupported CID version ${version}` }),
    );
  }
  if (codec >= MULTI_BYTE_VARINT_LIMIT) {
    return Result.fail(
      new CidError({ message: 'multi-byte codec varints are not supported' }),
    );
  }
  if (hashCode !== MULTIHASH_SHA2_256) {
    return Result.fail(
      new CidError({ message: `unsupported multihash code ${hashCode}` }),
    );
  }
  if (digestLength !== SHA2_256_DIGEST_LENGTH) {
    return Result.fail(
      new CidError({
        message: `unsupported sha2-256 digest length ${digestLength}`,
      }),
    );
  }
  if (bytes.length !== DIGEST_OFFSET + digestLength) {
    return Result.fail(
      new CidError({ message: 'CID length does not match its digest length' }),
    );
  }

  return Result.succeed({
    version,
    codec,
    digest: bytes.slice(DIGEST_OFFSET),
  });
};
