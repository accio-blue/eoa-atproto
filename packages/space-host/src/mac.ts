import { type CryptoError, hmacSha256 } from '@eoa/crypto';
import { Data, Effect } from 'effect';
import { concatBytes } from '@eoa/core';
import { constantTimeEqual } from './lthash.js';

/**
 * The MACs that replaced commit signatures, and the two headers that carry them (spaces alpha,
 * 2026-10-22, sections 4d–4e).
 *
 * A commit no longer travels signed: the syncer and the repo host agree on a per-request secret
 * (`kem.ts`), and the repo host answers with an HMAC. That makes the response deniable — a MAC
 * proves authorship only to whoever holds the secret, and a leaked response proves nothing to a
 * third party.
 *
 * The request asks for it, per method, with a Structured Field dictionary:
 *
 *     Atproto-Space-Want-Mac: type="atproto-space-repo", ver=1, key_share="did:key:zDna..."
 *
 * and the response answers in kind, alongside `Vary` so a cache does not mix two requests' MACs:
 *
 *     Atproto-Space-Mac: type="atproto-space-repo", ver=1, mac=:<base64>:
 *
 * Only the dictionary shape these two headers use is parsed here — members of scalar values, no
 * inner lists or parameters. Anything else is a header error rather than a guess, which is what the
 * spec asks for: a malformed header, an unsupported type or version, or an invalid key is
 * `BadSpaceMac`.
 */

/** The type a commit-bearing response names: `getLatestCommit`, `getRepo`, `listRepoOps`. */
export const COMMIT_MAC_TYPE = 'atproto-space-repo';

/** The type a `getRecord` response names. */
export const RECORD_MAC_TYPE = 'atproto-space-record';

/** The only MAC version this module speaks. */
export const MAC_VERSION = 1;

/** The request header that carries the ephemeral `did:key`. */
export const WANT_MAC_HEADER = 'Atproto-Space-Want-Mac';

/** The response header that carries the MAC. */
export const MAC_HEADER = 'Atproto-Space-Mac';

const COMMIT_CONTEXT = new TextEncoder().encode('atproto-space-repo-v1');
const RECORD_CONTEXT = new TextEncoder().encode('atproto-space-record-v1');

const encoder = new TextEncoder();

export class SpaceMacError extends Data.TaggedError('SpaceMacError')<{
  readonly reason: 'header' | 'type' | 'version' | 'key';
  readonly message: string;
}> {}

export interface WantMac {
  readonly type: string;
  readonly ver: number;
  /** The syncer's ephemeral public key as a `did:key`. */
  readonly keyShare: string;
}

export interface MacHeader {
  readonly type: string;
  readonly ver: number;
  readonly mac: Uint8Array;
}

const uint16be = (value: number): Uint8Array =>
  Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);

/** A string field in a MAC context: the bytes, and their length as a big-endian uint16. */
const prefixed = (value: string): Uint8Array => {
  const bytes = encoder.encode(value);
  return concatBytes([uint16be(bytes.length), bytes]);
};

/**
 * The commit MAC: a context naming the space, the repo and the revision, then the digest. The
 * revision is in the context so a MAC cannot be replayed at a different revision of the same repo.
 */
export const computeCommitMac = (params: {
  readonly sharedSecret: Uint8Array;
  readonly space: string;
  readonly repo: string;
  readonly rev: string;
  readonly data: Uint8Array;
}): Effect.Effect<Uint8Array, CryptoError> =>
  hmacSha256(
    params.sharedSecret,
    concatBytes([
      COMMIT_CONTEXT,
      prefixed(params.space),
      prefixed(params.repo),
      prefixed(params.rev),
      params.data,
    ]),
  );

/** The record MAC: the full record URI and the record's binary CID. */
export const computeRecordMac = (params: {
  readonly sharedSecret: Uint8Array;
  readonly uri: string;
  readonly cid: Uint8Array;
}): Effect.Effect<Uint8Array, CryptoError> =>
  hmacSha256(
    params.sharedSecret,
    concatBytes([RECORD_CONTEXT, prefixed(params.uri), params.cid]),
  );

export const verifyCommitMac = (
  params: Parameters<typeof computeCommitMac>[0] & { readonly mac: Uint8Array },
): Effect.Effect<boolean, CryptoError> =>
  computeCommitMac(params).pipe(
    Effect.map((expected) => constantTimeEqual(expected, params.mac)),
  );

export const verifyRecordMac = (
  params: Parameters<typeof computeRecordMac>[0] & { readonly mac: Uint8Array },
): Effect.Effect<boolean, CryptoError> =>
  computeRecordMac(params).pipe(
    Effect.map((expected) => constantTimeEqual(expected, params.mac)),
  );

const base64Of = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

const base64Into = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/**
 * A Structured Field dictionary as these headers use it: `key=value` members of scalar values. The
 * split has to respect quoted strings, because a `did:key` never contains a comma but a path could.
 */
const splitMembers = (value: string): ReadonlyArray<string> => {
  const members: Array<string> = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === ',' && !quoted) {
      members.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  members.push(current);
  return members;
};

type Member = string | number | Uint8Array;

const parseMember = (member: string): [string, Member] => {
  const at = member.indexOf('=');
  if (at === -1) {
    throw new SpaceMacError({
      reason: 'header',
      message: `member "${member.trim()}" is not key=value`,
    });
  }
  const key = member.slice(0, at).trim();
  const raw = member.slice(at + 1).trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
    throw new SpaceMacError({
      reason: 'header',
      message: `member key "${key}" is not a token`,
    });
  }
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) {
      throw new SpaceMacError({
        reason: 'header',
        message: `member "${key}" has an unterminated string`,
      });
    }
    const inner = raw.slice(1, -1);
    if (/(?<!\\)"/.test(inner)) {
      throw new SpaceMacError({
        reason: 'header',
        message: `member "${key}" has an unescaped quote`,
      });
    }
    return [key, inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\')];
  }
  if (raw.startsWith(':')) {
    if (!raw.endsWith(':') || raw.length < 2) {
      throw new SpaceMacError({
        reason: 'header',
        message: `member "${key}" has an unterminated byte sequence`,
      });
    }
    return [key, base64Into(raw.slice(1, -1))];
  }
  if (/^-?\d{1,15}$/.test(raw)) {
    return [key, Number.parseInt(raw, 10)];
  }
  throw new SpaceMacError({
    reason: 'header',
    message: `member "${key}" has an unsupported value`,
  });
};

const dictionaryOf = (value: string) => {
  const dictionary = new Map<string, Member>();
  for (const member of splitMembers(value)) {
    if (member.trim() === '') {
      throw new SpaceMacError({
        reason: 'header',
        message: 'a dictionary member is empty',
      });
    }
    const [key, parsed] = parseMember(member);
    if (dictionary.has(key)) {
      throw new SpaceMacError({
        reason: 'header',
        message: `member "${key}" appears twice`,
      });
    }
    dictionary.set(key, parsed);
  }
  return dictionary;
};

const stringMember = (dictionary: Map<string, Member>, key: string): string => {
  const value = dictionary.get(key);
  if (typeof value !== 'string') {
    throw new SpaceMacError({
      reason: 'header',
      message: `member "${key}" is missing or is not a string`,
    });
  }
  return value;
};

const versionMember = (dictionary: Map<string, Member>): number => {
  const value = dictionary.get('ver');
  if (typeof value !== 'number') {
    throw new SpaceMacError({
      reason: 'version',
      message: 'member "ver" is missing or is not an integer',
    });
  }
  return value;
};

const attempt = <A>(run: () => A): Effect.Effect<A, SpaceMacError> =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SpaceMacError
        ? error
        : new SpaceMacError({
            reason: 'header',
            message: error instanceof Error ? error.message : String(error),
          }),
  });

/** Read `Atproto-Space-Want-Mac`: the method's type, the version, and the ephemeral key. */
export const parseWantMac = (
  value: string,
): Effect.Effect<WantMac, SpaceMacError> =>
  attempt(() => {
    const dictionary = dictionaryOf(value);
    const type = stringMember(dictionary, 'type');
    const ver = versionMember(dictionary);
    const keyShare = stringMember(dictionary, 'key_share');
    if (ver !== MAC_VERSION) {
      throw new SpaceMacError({
        reason: 'version',
        message: `version ${ver} is not ${MAC_VERSION}`,
      });
    }
    if (!keyShare.startsWith('did:key:')) {
      throw new SpaceMacError({
        reason: 'key',
        message: 'key_share is not a did:key',
      });
    }
    return { type, ver, keyShare };
  });

/** Write `Atproto-Space-Want-Mac`. */
export const formatWantMac = (params: WantMac): string =>
  `type="${params.type}", ver=${params.ver}, key_share="${params.keyShare}"`;

/** Read `Atproto-Space-Mac`: the echo of the request's type and version, and the MAC. */
export const parseMac = (
  value: string,
): Effect.Effect<MacHeader, SpaceMacError> =>
  attempt(() => {
    const dictionary = dictionaryOf(value);
    const type = stringMember(dictionary, 'type');
    const ver = versionMember(dictionary);
    const mac = dictionary.get('mac');
    if (!(mac instanceof Uint8Array)) {
      throw new SpaceMacError({
        reason: 'header',
        message: 'member "mac" is missing or is not a byte sequence',
      });
    }
    return { type, ver, mac };
  });

/** Write `Atproto-Space-Mac`. */
export const formatMac = (params: MacHeader): string =>
  `type="${params.type}", ver=${params.ver}, mac=:${base64Of(params.mac)}:`;
