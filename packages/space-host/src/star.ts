import {
  CODEC_DAG_CBOR,
  type CborValue,
  type Cid,
  CidLink,
  TID,
  cidFromDigest,
  concatBytes,
  decodeCbor,
  encodeCbor,
} from '@eoa/core';
import { type CryptoError, sha256 } from '@eoa/crypto';
import { Data, Effect, Schema } from 'effect';

import { constantTimeEqual, ltHashDigestOf } from './lthash.js';
import { type SpaceCommit } from './commit.js';

/**
 * The STAR archive of a permissioned repo (spaces alpha, 2026-10-22).
 *
 * A space repo used to travel as a two-root CAR: a commit block, an index block and one block per
 * record, every block content-addressed. STAR replaces it, and it is much less: a fixed magic, one
 * CBOR metadata object, then ordered `key → value` pairs. There are no CIDs on the wire and no
 * index block — a record's CID is what its bytes hash to, recomputed by whoever needs it — which is
 * both smaller and stricter, because anything ambiguous is a parse error rather than a tolerated
 * extra block.
 *
 * The format is the medium; the **profile** is what makes it a space repo (`atproto-space-repo`):
 *
 * - the metadata is the commit itself -- `ver`, `repo`, `space`, `rev`, `data` -- plus the `$type`
 *   that names the profile; `data` is the digest that makes truncation at a pair boundary
 *   detectable (a STAR reader cannot see that by itself);
 * - keys are record paths (`{collection}/{rkey}`), in strict lexicographic order, no duplicates;
 * - values are at most 1 MiB (the record limit), and are the record's CBOR.
 *
 * The digest is our LtHash (`lthash.ts`): the set of `(path, cid)` pairs, order-independent, hashed
 * once more with sha256. The commit's signature is gone and its MAC travels as a response header over
 * a per-request shared secret (`#atproto_kem`, `Atproto-Space-Mac`), so what this module proves is
 * that the bytes are a whole, well-formed space repo at the named revision. Who committed it is the
 * caller's check, against the header the bytes arrived with.
 *
 * Two profiles travel in this framing, and the metadata's `$type` is what tells them apart
 * (`starProfileOf`):
 *
 * - `atproto-space-repo` (2026-10-22): one repo's records in one space — what a syncer reads and a
 *   repo host imports.
 * - `atproto-space-meta` (2026-10-29, account migration): the space authority's *host-side* state —
 *   its policy, the state the policy keeps (a `memberspace` member list), and the writer set — in
 *   three strictly ordered sections. This is the half of a spaces account that does not ride the
 *   public repo, so a move that carries only the repo loses it silently. The meta archive has to
 *   land on the new host *before* the authority's repo in that space, or the repo import answers
 *   `SpaceNotFound`.
 *
 * The other half of a space's metadata is a record: the policy and member list a host *publishes*
 * (`publishPolicy`, `publishMembers`) are ordinary records in the authority's own repo —
 * `com.atproto.space.policy/self` and `com.atproto.memberspace.member/{did}` — and travel in that
 * repo's CAR. So "authority metadata" is both, split by who it is for: the published records are what
 * readers and syncers see, and the meta archive is what the host enforces.
 */

/** `*l\x01\x00`: "star", lite, v1, and a null to make four. */
export const STAR_MAGIC = Uint8Array.from([0x2a, 0x6c, 0x01, 0x00]);

/** The metadata `$type` that makes an archive a space repository. */
export const SPACE_REPO_STAR = 'atproto-space-repo';

/** The commit version this profile carries; the metadata's `ver` must be it. */
export const SPACE_COMMIT_VER = 1;

/**
 * The metadata `$type` that makes an archive a space's host-side state, which is what an account
 * migration carries beside the account's own repo (2026-10-29, section 5b).
 *
 * The profile was called `atproto-space-host` while the migration PR was open and was renamed to
 * `atproto-space-meta` before the release; the migration prompt and the reference implementation at
 * `5d88b414` both say `-meta`, and that is the one a receiving host will accept.
 */
export const SPACE_META_STAR = 'atproto-space-meta';

/** The version the migration profile carries; the metadata's `ver` must be it. */
export const SPACE_META_VER = 1;

/**
 * Which profile an archive follows, read from the archive itself: the metadata `$type`, narrowed to
 * the two profiles this module understands. The profile *is* its `$type`; a separate label per
 * profile would be a second name for the same thing, kept in sync by hand.
 */
export type StarProfile = typeof SPACE_REPO_STAR | typeof SPACE_META_STAR;

/** The profile's per-record ceiling: an atproto record is at most a megabyte. */
export const SPACE_RECORD_MAX_BYTES = 1024 * 1024;

/** The format's own ceilings, from the specification. */
const META_MAX_BYTES = 64 * 1024 * 1024;
const KEY_MAX_BYTES = 64 * 1024 * 1024;
const VALUE_MAX_BYTES = 64 * 1024 * 1024 * 1024;

/** The one key that opens a meta archive: the space's policy object. */
const POLICY_KEY = 'policy';
/** Every writer-set entry, keyed by the DID of the repo that holds it. */
const WRITER_KEY_PREFIX = 'writer/';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** The record index: `{collection}/{rkey}` to the CID of its block. */
export type RepoIndex = Readonly<Record<string, Cid>>;

export interface RepoRecord {
  readonly path: string;
  readonly block: Uint8Array;
}

/**
 * What a space archive says about itself: the commit (`commit.ts`) plus the `$type` that says which
 * profile the archive follows.
 */
export interface SpaceRepoMeta extends SpaceCommit {
  readonly $type: typeof SPACE_REPO_STAR;
}

export interface SpaceRepoArchive {
  readonly meta: SpaceRepoMeta;
  readonly records: ReadonlyArray<RepoRecord>;
}

/** A meta archive's metadata: which space this is the host-side state of. */
export interface SpaceMetaStarMeta {
  readonly $type: typeof SPACE_META_STAR;
  readonly ver: typeof SPACE_META_VER;
  readonly space: string;
}

/**
 * One value in a meta archive. The profile defines which schema each key carries (a policy, a
 * member entry, a writer entry); what this module can say is that it is a CBOR map.
 */
export type SpaceMetaValue = { readonly [key: string]: CborValue };

/**
 * A repo in the space's writer set, as an archive carries it.
 *
 * `spaceRev` is kept so the host's `listRepos` cursors stay valid across a migration: a syncer that
 * resumes from a revision it saw on the old host still recognises the repo here.
 *
 * **What this is not:** the present writer set. On this host the archive is written by an import and
 * by policy/member edits, while a record write appends to the space write log and never touches the
 * archive — so a repo that has written since the last import is in the log and not here.
 * `com.atproto.space.listRepos` answers from the log (`puls`); this section is the mover's copy of
 * the set as it arrived, and a mover carries every repo itself, so it never has to trust it.
 */
export interface SpaceMetaWriter {
  readonly did: string;
  readonly rev: string;
  /** The repo's digest, 32 bytes: what `spaceRev` was the revision of. */
  readonly data: Uint8Array;
  readonly spaceRev: string;
}

/**
 * A space authority's host-side state, as the `atproto-space-meta` archive carries it.
 *
 * Three sections, in this order, each in strict key order: the policy, the state the policy keeps
 * (keyed like record paths, `{nsid}/{rkey}`), then one `writer/{did}` entry per writer.
 */
export interface SpaceMetaArchive {
  readonly meta: SpaceMetaStarMeta;
  readonly policy: SpaceMetaValue;
  readonly policyState: ReadonlyArray<{
    readonly key: string;
    readonly value: SpaceMetaValue;
  }>;
  /** The writer set **as it arrived**: see `SpaceMetaWriter` for what that is not. */
  readonly writers: ReadonlyArray<SpaceMetaWriter>;
}

export class StarError extends Data.TaggedError('StarError')<{
  readonly reason: StarInvalidReason;
  readonly message: string;
}> {}

export type StarInvalidReason =
  | 'magic'
  | 'truncated'
  | 'varint'
  | 'meta'
  | 'order'
  /** A meta archive's sections are out of order, or it has no policy at all. */
  | 'section'
  /** A `writer/{did}` entry that is not one. */
  | 'writer'
  | 'size'
  | 'digest-mismatch';

export type StarVerification =
  | {
      readonly valid: true;
      readonly meta: SpaceRepoMeta;
      readonly index: RepoIndex;
    }
  | { readonly valid: false; readonly reason: StarInvalidReason };

const invalid = (reason: StarInvalidReason, message: string) =>
  new StarError({ reason, message });

const attempt = <A>(run: () => A): Effect.Effect<A, StarError> =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof StarError
        ? error
        : new StarError({
            // Anything the framer itself throws (a RangeError from a slice, say) is the archive's
            // shape, so it is reported as a metadata failure rather than dressed up as a rule.
            reason: 'meta',
            message: error instanceof Error ? error.message : String(error),
          }),
  });

const varintOf = (value: number): Uint8Array => {
  const out: Array<number> = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Uint8Array.from(out);
};

/**
 * An unsigned varint, canonical as the specification demands: a multi-byte number may not end in a
 * zero byte, because that would be a longer way to say a smaller number.
 */
const readVarint = (bytes: Uint8Array, offset: number) => {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = bytes.at(cursor);
    if (byte === undefined) {
      throw invalid('truncated', 'a length ends where the archive does');
    }
    if (cursor > offset && (byte & 0x80) === 0 && byte === 0) {
      throw invalid('varint', 'a length is not in canonical form');
    }
    value += (byte & 0x7f) * 2 ** shift;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, next: cursor };
    }
    shift += 7;
    if (shift > 42) {
      throw invalid('varint', 'a length is longer than six bytes');
    }
  }
};

const isPlainMap = (
  value: CborValue,
): value is { readonly [key: string]: CborValue } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  !(value instanceof CidLink);

const metaOf = (value: CborValue): SpaceRepoMeta => {
  if (!isPlainMap(value)) {
    throw invalid('meta', 'the metadata is not a map');
  }
  const { $type, ver, repo, space, rev, data } = value;
  if ($type !== SPACE_REPO_STAR) {
    throw invalid('meta', `the metadata is not a ${SPACE_REPO_STAR}`);
  }
  if (ver !== SPACE_COMMIT_VER) {
    throw invalid('meta', `the commit version is not ${SPACE_COMMIT_VER}`);
  }
  if (typeof repo !== 'string' || !repo.startsWith('did:')) {
    throw invalid('meta', 'the repo is not a DID');
  }
  if (typeof space !== 'string' || !space.startsWith('at://')) {
    throw invalid('meta', 'the space is not an at-uri');
  }
  if (!Schema.is(TID)(rev)) {
    throw invalid('meta', 'the revision is not a TID');
  }
  if (!(data instanceof Uint8Array) || data.length !== 32) {
    throw invalid('meta', 'the digest is not 32 bytes');
  }
  return {
    $type: SPACE_REPO_STAR,
    ver: SPACE_COMMIT_VER,
    repo,
    space,
    rev,
    data,
  };
};

export const blockCidOf = (
  block: Uint8Array,
): Effect.Effect<Cid, CryptoError> =>
  sha256(block).pipe(
    Effect.map((digest) => cidFromDigest({ codec: CODEC_DAG_CBOR, digest })),
  );

/** The metadata as it travels: a map, so `encodeCbor` takes it as one. */
const metaCbor = (meta: SpaceRepoMeta): CborValue => ({
  $type: meta.$type,
  ver: meta.ver,
  repo: meta.repo,
  space: meta.space,
  rev: meta.rev,
  data: meta.data,
});

/** The LtHash elements the metadata's digest covers. */
export const indexElements = (index: RepoIndex): ReadonlyArray<Uint8Array> =>
  Object.entries(index).map(([path, cid]) =>
    encodeCbor([path, new CidLink({ cid })]),
  );

/** The archive's digest: every `(path, cid)` pair, folded by LtHash, hashed once. */
export const digestOf = (
  index: RepoIndex,
): Effect.Effect<Uint8Array, CryptoError> =>
  ltHashDigestOf(indexElements(index));

/** The meta archive's metadata, as it travels. */
const metaHeaderCbor = (meta: SpaceMetaStarMeta): CborValue => ({
  $type: meta.$type,
  ver: meta.ver,
  space: meta.space,
});

/**
 * STAR's key order: bytewise, and a shorter key before a longer one that starts with it.
 *
 * `@eoa/core`'s comparator is private, and a local copy is four lines against a public export from a
 * package that does not otherwise need to know about ordering.
 */
const compareKeys = (left: Uint8Array, right: Uint8Array): number => {
  const shared = Math.min(left.length, right.length);
  for (let at = 0; at < shared; at += 1) {
    if (left[at] !== right[at]) {
      return (left[at] ?? 0) - (right[at] ?? 0);
    }
  }
  return left.length - right.length;
};

/** One framed pair, still as bytes: what a key and a value mean is the profile's business. */
interface StarPair {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

/**
 * The keys strictly ascending, bytewise, with no duplicate.
 *
 * Both profiles require it and both encoders sort before framing, so this is the rule a caller that
 * handed over a duplicate is refused by — on the way in as well as on the way out.
 */
const assertAscending = (pairs: ReadonlyArray<StarPair>): void => {
  for (const [at, pair] of pairs.entries()) {
    const previous = pairs[at - 1];
    if (previous !== undefined && compareKeys(previous.key, pair.key) >= 0) {
      throw invalid(
        'order',
        `key ${TEXT_DECODER.decode(pair.key)} is out of order or duplicated`,
      );
    }
  }
};

/** The magic, the metadata, then the pairs — the framing every STAR profile shares. */
const archiveBytes = (
  meta: CborValue,
  pairs: ReadonlyArray<StarPair>,
): Uint8Array => {
  const header = encodeCbor(meta);
  const frames: Array<Uint8Array> = [];
  for (const pair of pairs) {
    frames.push(
      concatBytes([
        varintOf(pair.key.length),
        pair.key,
        varintOf(pair.value.length),
        pair.value,
      ]),
    );
  }
  return concatBytes([STAR_MAGIC, varintOf(header.length), header, ...frames]);
};

/** The magic and the metadata: everything before the first pair, whatever the profile. */
interface StarHeader {
  readonly meta: CborValue;
  readonly offset: number;
}

const starHeaderSync = (bytes: Uint8Array): StarHeader => {
  for (const [at, expected] of STAR_MAGIC.entries()) {
    if (bytes.at(at) !== expected) {
      throw invalid('magic', 'the archive does not begin with the STAR magic');
    }
  }
  const header = readVarint(bytes, STAR_MAGIC.length);
  if (header.value > META_MAX_BYTES) {
    throw invalid('meta', 'the metadata is over its ceiling');
  }
  const headerBytes = bytes.slice(header.next, header.next + header.value);
  if (headerBytes.length !== header.value) {
    throw invalid('truncated', 'the metadata ends where the archive does');
  }
  const meta = (() => {
    try {
      return decodeCbor(headerBytes);
    } catch {
      throw invalid('meta', 'the metadata is not CBOR');
    }
  })();
  return { meta, offset: header.next + header.value };
};

/**
 * The pairs after the metadata, framed and checked: EOF only at a pair boundary, and no value over
 * the ceiling the profile sets.
 *
 * Key order is **not** checked here, because it is the profile's rule and the two do not agree: a
 * repo's keys are record paths in one global order, while a meta archive's `policy` key comes first
 * even though `com.atproto...` sorts before it, and only each of its three sections is ordered.
 */
const starPairsSync = (
  bytes: Uint8Array,
  offset: number,
  maxValueBytes: number,
): ReadonlyArray<StarPair> => {
  const pairs: Array<StarPair> = [];
  let cursor = offset;
  while (cursor < bytes.length) {
    const keyLength = readVarint(bytes, cursor);
    if (keyLength.value > KEY_MAX_BYTES) {
      throw invalid('size', 'a key is over its ceiling');
    }
    const keyEnd = keyLength.next + keyLength.value;
    const key = bytes.slice(keyLength.next, keyEnd);
    if (key.length !== keyLength.value) {
      throw invalid('truncated', 'a key ends where the archive does');
    }
    const valueLength = readVarint(bytes, keyEnd);
    if (valueLength.value > VALUE_MAX_BYTES) {
      throw invalid('size', 'a value is over its ceiling');
    }
    const valueEnd = valueLength.next + valueLength.value;
    const value = bytes.slice(valueLength.next, valueEnd);
    if (value.length !== valueLength.value) {
      throw invalid('truncated', 'a value ends where the archive does');
    }
    if (valueLength.value > maxValueBytes) {
      throw invalid('size', 'a value is over the profile ceiling');
    }
    pairs.push({ key, value });
    cursor = valueEnd;
  }
  return pairs;
};

/**
 * Encode an archive. The pairs are sorted here rather than trusted: the profile requires strict key
 * order, and a caller that hands them over unsorted is asking for an archive no conforming reader
 * would accept.
 */
export const encodeRepoStar = (
  archive: SpaceRepoArchive,
): Effect.Effect<Uint8Array, StarError> =>
  Effect.gen(function* () {
    // The domain type is checked by the same validator a reader uses: one set of rules.
    const meta = yield* attempt(() => metaOf(metaCbor(archive.meta)));
    return yield* attempt(() => {
      const pairs = archive.records
        .map((record) => {
          if (record.path.length > KEY_MAX_BYTES) {
            throw invalid('size', `key too long: ${record.path}`);
          }
          if (record.block.length > SPACE_RECORD_MAX_BYTES) {
            throw invalid('size', `record ${record.path} is over a megabyte`);
          }
          return {
            key: TEXT_ENCODER.encode(record.path),
            value: record.block,
          };
        })
        .sort((left, right) => compareKeys(left.key, right.key));
      assertAscending(pairs);
      return archiveBytes(metaCbor(meta), pairs);
    });
  });

const parseRepoStarSync = (bytes: Uint8Array): SpaceRepoArchive => {
  const { meta: raw, offset } = starHeaderSync(bytes);
  const meta = metaOf(raw);
  const pairs = starPairsSync(bytes, offset, SPACE_RECORD_MAX_BYTES);
  assertAscending(pairs);
  return {
    meta,
    records: pairs.map((pair) => ({
      path: TEXT_DECODER.decode(pair.key),
      block: pair.value,
    })),
  };
};

/** Read an archive without trusting it: the bytes are framable, and that is all this says. */
export const parseRepoStar = (
  bytes: Uint8Array,
): Effect.Effect<SpaceRepoArchive, StarError> =>
  attempt(() => parseRepoStarSync(bytes));

/**
 * Verify an archive end to end: the magic, the metadata, the framing, the key order, and the
 * digest. What it cannot say is who wrote it -- the commit's signature and MAC travel in headers
 * now -- so a caller that needs authorship checks the headers it got the bytes with.
 */
export const verifyRepoStar = (
  bytes: Uint8Array,
): Effect.Effect<StarVerification, CryptoError> =>
  Effect.gen(function* () {
    const parsed = yield* parseRepoStar(bytes).pipe(
      Effect.map((archive) => ({ ok: archive }) as const),
      Effect.catchTag('StarError', (error) =>
        Effect.succeed({ ok: error.reason } as const),
      ),
    );
    if (typeof parsed.ok === 'string') {
      return { valid: false as const, reason: parsed.ok };
    }
    const archive = parsed.ok;

    const index: Record<string, Cid> = {};
    for (const record of archive.records) {
      index[record.path] = yield* blockCidOf(record.block);
    }
    const digest = yield* digestOf(index);
    return constantTimeEqual(digest, archive.meta.data)
      ? { valid: true as const, meta: archive.meta, index }
      : { valid: false as const, reason: 'digest-mismatch' as const };
  });

/**
 * Which profile an archive claims to be, read from its metadata and nothing else.
 *
 * A reader that is handed bytes it did not produce needs this first: the two profiles in this module
 * mean different things about the same framing, and a `atproto-space-meta` archive read as a
 * `atproto-space-repo` one is not a malformed repo — it is a different document whose `$type` was
 * never checked. `verifyRepoStar` refuses it as `meta`, and this makes the reason legible.
 *
 * `undefined` is a profile this release does not know: report it rather than guess, and let the
 * caller refuse. Bytes that are not STAR at all are an error, not `undefined` — the framing failed
 * before there was a `$type` to read.
 */
export const starProfileOf = (
  bytes: Uint8Array,
): Effect.Effect<StarProfile | undefined, StarError> =>
  attempt(() => {
    const { meta } = starHeaderSync(bytes);
    if (!isPlainMap(meta)) {
      throw invalid('meta', 'the metadata is not a map');
    }
    const profile = meta['$type'];
    if (typeof profile !== 'string') {
      throw invalid('meta', 'the metadata does not name a profile');
    }
    return profile === SPACE_REPO_STAR || profile === SPACE_META_STAR
      ? profile
      : undefined;
  });

const metaHeaderOf = (value: CborValue): SpaceMetaStarMeta => {
  if (!isPlainMap(value)) {
    throw invalid('meta', 'the metadata is not a map');
  }
  const { $type, ver, space } = value;
  if ($type !== SPACE_META_STAR) {
    throw invalid('meta', `the metadata is not a ${SPACE_META_STAR}`);
  }
  if (ver !== SPACE_META_VER) {
    throw invalid('meta', `the profile version is not ${SPACE_META_VER}`);
  }
  if (typeof space !== 'string' || !space.startsWith('at://')) {
    throw invalid('meta', 'the space is not an at-uri');
  }
  return { $type: SPACE_META_STAR, ver: SPACE_META_VER, space };
};

/** The sections of a meta archive, in the order the profile requires them. */
const POLICY_SECTION = 0;
const STATE_SECTION = 1;
const WRITER_SECTION = 2;

/**
 * Which section a key belongs to. Everything that is neither the policy nor a writer is policy
 * state, keyed like a record path — which is what makes an unknown key refusable by the policy
 * layer rather than droppable here.
 */
const sectionOf = (key: string): number => {
  if (key === POLICY_KEY) {
    return POLICY_SECTION;
  }
  return key.startsWith(WRITER_KEY_PREFIX) ? WRITER_SECTION : STATE_SECTION;
};

const metaValueOf = (bytes: Uint8Array, key: string): SpaceMetaValue => {
  const value = (() => {
    try {
      return decodeCbor(bytes);
    } catch {
      throw invalid('meta', `the value at ${key} is not CBOR`);
    }
  })();
  if (!isPlainMap(value)) {
    throw invalid('meta', `the value at ${key} is not a map`);
  }
  return value;
};

const writerOf = (key: string, value: SpaceMetaValue): SpaceMetaWriter => {
  const did = key.slice(WRITER_KEY_PREFIX.length);
  if (!did.startsWith('did:')) {
    throw invalid('writer', `a writer key does not name a DID: ${key}`);
  }
  const { rev, data, spaceRev } = value;
  if (!Schema.is(TID)(rev)) {
    throw invalid('writer', `the writer at ${key} has no revision`);
  }
  if (!Schema.is(TID)(spaceRev)) {
    throw invalid('writer', `the writer at ${key} has no space revision`);
  }
  if (!(data instanceof Uint8Array) || data.length !== 32) {
    throw invalid('writer', `the writer at ${key} has no 32-byte digest`);
  }
  return { did, rev, data, spaceRev };
};

const writerPairOf = (writer: SpaceMetaWriter): StarPair => {
  const key = `${WRITER_KEY_PREFIX}${writer.did}`;
  // The same validator a reader uses, so an encoder cannot write what a reader refuses.
  const value = writerOf(key, {
    rev: writer.rev,
    data: writer.data,
    spaceRev: writer.spaceRev,
  });
  return {
    key: TEXT_ENCODER.encode(key),
    value: encodeCbor({
      rev: value.rev,
      data: value.data,
      spaceRev: value.spaceRev,
    }),
  };
};

/**
 * Read a space's host-side state, the archive an account migration carries: the policy, the state
 * the policy keeps, and the writer set.
 *
 * The sections are checked rather than trusted — an archive whose policy arrives after its writers,
 * or which has no policy at all, is not a shorter archive but a broken one — because importing it
 * half-way is a space whose access rules nobody can state.
 */
export const parseSpaceMetaStar = (
  bytes: Uint8Array,
): Effect.Effect<SpaceMetaArchive, StarError> =>
  attempt(() => {
    const { meta: raw, offset } = starHeaderSync(bytes);
    const meta = metaHeaderOf(raw);
    let policy: SpaceMetaValue | undefined;
    const policyState: Array<{ key: string; value: SpaceMetaValue }> = [];
    const writers: Array<SpaceMetaWriter> = [];
    let section = -1;
    let previous: Uint8Array | undefined;
    // No profile ceiling on a value: the entries are a policy and small maps, and STAR's own is
    // the only limit the release sets for them.
    for (const pair of starPairsSync(bytes, offset, VALUE_MAX_BYTES)) {
      const key = TEXT_DECODER.decode(pair.key);
      const of = sectionOf(key);
      if (of < section) {
        throw invalid(
          'section',
          `the section at ${key} comes after a later one`,
        );
      }
      if (of === section) {
        // Within a section, the profile's own strict order — and never across sections, where the
        // policy key sits first whatever its bytes sort like.
        if (previous !== undefined && compareKeys(previous, pair.key) >= 0) {
          throw invalid('order', `key ${key} is out of order or duplicated`);
        }
      } else {
        section = of;
        previous = undefined;
      }
      previous = pair.key;
      const value = metaValueOf(pair.value, key);
      if (of === POLICY_SECTION) {
        policy = value;
      } else if (of === WRITER_SECTION) {
        writers.push(writerOf(key, value));
      } else {
        policyState.push({ key, value });
      }
    }
    if (policy === undefined) {
      throw invalid('section', 'the archive has no policy');
    }
    return { meta, policy, policyState, writers };
  });

/**
 * Write a space's host-side state. Each section is put into key order here, for the reason the repo
 * encoder sorts: order is the profile's rule, and a caller that hands over an unordered member list
 * is asking for an archive a host would refuse to import.
 */
export const encodeSpaceMetaStar = (
  archive: SpaceMetaArchive,
): Effect.Effect<Uint8Array, StarError> =>
  attempt(() => {
    const meta = metaHeaderOf(metaHeaderCbor(archive.meta));
    const state = archive.policyState
      .map((entry) => {
        if (sectionOf(entry.key) !== STATE_SECTION) {
          throw invalid(
            'section',
            `the policy state key ${entry.key} names a section of its own`,
          );
        }
        return {
          key: TEXT_ENCODER.encode(entry.key),
          value: encodeCbor(entry.value),
        };
      })
      .sort((left, right) => compareKeys(left.key, right.key));
    const writers = archive.writers
      .map(writerPairOf)
      .sort((left, right) => compareKeys(left.key, right.key));
    const pairs = [
      {
        key: TEXT_ENCODER.encode(POLICY_KEY),
        value: encodeCbor(archive.policy),
      },
      ...state,
      ...writers,
    ];
    // Per section, not across them: the policy key opens the archive and its bytes sort after the
    // policy-state keys, which is the profile's shape rather than an ordering mistake.
    assertAscending(state);
    assertAscending(writers);
    return archiveBytes(metaHeaderCbor(meta), pairs);
  });
