import { ATURI, DID, NSID, TID } from '@eoa/core';
import { CidString, type Grant, type StrongRef } from './grant.js';
import { DateTime, Schema } from 'effect';
import type { MembershipEntry, SpaceAuthority } from './space.js';
import { RecordKey, type SpaceRecordOp } from './write-log.js';
import type { StoredConnection, StoredGrantAcceptance } from './consent.js';
import type { StoredGrant } from './evaluate.js';

/** Test fixtures: branded ids and grant/op builders. Not part of the public API. */
export const aturi = Schema.decodeSync(ATURI);
export const did = Schema.decodeSync(DID);
export const nsid = Schema.decodeSync(NSID);
export const cid = Schema.decodeSync(CidString);
export const rkey = Schema.decodeSync(RecordKey);
export const tid = Schema.decodeSync(TID);

export const SPACE = aturi('at://did:plc:authority/ing.lexicon.space/club');
export const AUTHORITY = did('did:plc:authority');
export const ALICE = did('did:plc:alice');
export const BOB = did('did:plc:bob');
export const ROLE = did('did:plc:members');
export const RUNS = nsid('ing.lexicon.run');
export const NOTES = nsid('ing.lexicon.note');

export const utc = (iso: string) => DateTime.makeUnsafe(iso);
export const NOW = utc('2026-10-04T12:00:00Z');

export const grantRef = (n: number): StrongRef => ({
  uri: aturi(`at://did:plc:authority/ing.lexicon.grant/g${n}`),
  cid: cid(`bafygrant${n}`),
});

export const stored = (
  grant: Partial<Grant> = {},
  options: { readonly n?: number; readonly epoch?: number } = {},
): StoredGrant => ({
  ref: grantRef(options.n ?? 1),
  epoch: options.epoch ?? 1,
  grant: {
    space: SPACE,
    subject: ALICE,
    selectors: [{ collection: RUNS }],
    actions: ['view'],
    issuedBy: AUTHORITY,
    createdAt: utc('2026-01-01T00:00:00Z'),
    ...grant,
  },
});

export const op = (
  fields: Partial<SpaceRecordOp> & Pick<SpaceRecordOp, 'cid'>,
): SpaceRecordOp => ({
  space: SPACE,
  collection: RUNS,
  rkey: rkey('r1'),
  action: 'create',
  rev: tid('aaaaaaaaaaaaa'),
  author: ALICE,
  signature: new Uint8Array([1, 2, 3]),
  ...fields,
});

export const SPACE_TYPE = nsid('ing.lexicon.space');
export const SPACE_KEY = rkey('club');
export const RECOVERY = did('did:plc:recovery');

export const connectionRef = (n: number): StrongRef => ({
  uri: aturi(`at://did:plc:alice/ing.lexicon.connection/c${n}`),
  cid: cid(`bafyconn${n}`),
});

export const acceptanceRef = (n: number): StrongRef => ({
  uri: aturi(`at://did:plc:alice/ing.lexicon.grant.acceptance/a${n}`),
  cid: cid(`bafyaccept${n}`),
});

/** One half of a connection: `author` wrote it, `subject` is the other party, `other` their half. */
export const connectionHalf = (
  author: DID,
  subject: DID,
  ref: StrongRef,
  other: StrongRef,
): StoredConnection => ({
  ref,
  author,
  connection: {
    subject,
    connection: other,
    createdAt: utc('2026-01-01T00:00:00Z'),
  },
});

/** Both halves of a connection between `a` and `b`. */
export const mutualConnections = (
  a: DID,
  b: DID,
): readonly [StoredConnection, StoredConnection] => {
  const aRef = connectionRef(1);
  const bRef = connectionRef(2);
  return [connectionHalf(a, b, aRef, bRef), connectionHalf(b, a, bRef, aRef)];
};

export const storedAcceptance = (
  acceptedBy: DID,
  grant: StrongRef = grantRef(1),
  options: { readonly n?: number } = {},
): StoredGrantAcceptance => ({
  ref: acceptanceRef(options.n ?? 1),
  acceptance: {
    grant,
    acceptedBy,
    acceptedAt: utc('2026-01-01T00:00:00Z'),
  },
});

export const authority = (
  overrides: Partial<SpaceAuthority> = {},
): SpaceAuthority => ({
  space: SPACE,
  authority: AUTHORITY,
  admins: [],
  recovery: RECOVERY,
  ...overrides,
});

export const member = (
  who: DID,
  roles: ReadonlyArray<DID>,
  options: { readonly space?: ATURI } = {},
): MembershipEntry => ({
  space: options.space ?? SPACE,
  member: who,
  roles,
});
