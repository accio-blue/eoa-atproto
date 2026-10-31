import {
  ALICE,
  AUTHORITY,
  BOB,
  acceptanceRef,
  cid,
  connectionHalf,
  connectionRef,
  grantRef,
  mutualConnections,
  storedAcceptance,
} from './fixtures.js';
import {
  type ConsentInput,
  acceptanceSatisfies,
  consentFailure,
  consentHolds,
  consentRequired,
  isMutualConnection,
} from './consent.js';
import { describe, expect, it } from 'vitest';

describe('consent is demanded for USER DATA and a new purpose', () => {
  it('is not required for ordinary, already-known sharing', () => {
    expect(consentRequired({})).toBe(false);
    expect(consentRequired({ userData: false, newPurpose: false })).toBe(false);
  });

  it('is required for either flag, alone or together', () => {
    expect(consentRequired({ userData: true })).toBe(true);
    expect(consentRequired({ newPurpose: true })).toBe(true);
    expect(consentRequired({ userData: true, newPurpose: true })).toBe(true);
  });
});

describe('connection: a mutual opt-in, two halves', () => {
  const [mine, theirs] = mutualConnections(ALICE, AUTHORITY);

  it('holds when each half names the other and strongRefs it', () => {
    expect(isMutualConnection([mine, theirs], ALICE, AUTHORITY)).toBe(true);
  });

  it('does not hold on one half alone', () => {
    expect(isMutualConnection([mine], ALICE, AUTHORITY)).toBe(false);
  });

  it('does not hold when the halves do not point at each other', () => {
    const away = connectionHalf(AUTHORITY, ALICE, theirs.ref, connectionRef(3));
    expect(isMutualConnection([mine, away], ALICE, AUTHORITY)).toBe(false);
  });

  it('is about the named pair', () => {
    expect(isMutualConnection([mine, theirs], ALICE, BOB)).toBe(false);
  });
});

describe('grant acceptance: one exact grant, one subject', () => {
  it('satisfies its grant for its subject', () => {
    const acceptance = storedAcceptance(ALICE, grantRef(1));
    expect(acceptanceSatisfies([acceptance], grantRef(1), ALICE)).toBe(true);
  });

  it('does not satisfy another subject', () => {
    const acceptance = storedAcceptance(ALICE, grantRef(1));
    expect(acceptanceSatisfies([acceptance], grantRef(1), BOB)).toBe(false);
  });

  it('does not satisfy another grant, or an edited one (same uri, new cid)', () => {
    const acceptance = storedAcceptance(ALICE, grantRef(1));
    expect(acceptanceSatisfies([acceptance], grantRef(2), ALICE)).toBe(false);
    expect(
      acceptanceSatisfies(
        [acceptance],
        { ...grantRef(1), cid: cid('bafyother') },
        ALICE,
      ),
    ).toBe(false);
  });
});

describe('the consent gate, fail-closed', () => {
  const base = (overrides: Partial<ConsentInput> = {}): ConsentInput => ({
    grantRef: grantRef(1),
    issuedBy: AUTHORITY,
    subject: ALICE,
    connections: [],
    acceptances: [],
    ...overrides,
  });

  it('holds when no consent is demanded, record or not', () => {
    expect(consentFailure(base())).toBe(undefined);
    expect(consentHolds(base())).toBe(true);
  });

  it('fails as missing when demanded and the grant carries no reference', () => {
    expect(consentFailure(base({ userData: true }))).toBe('missing');
  });

  it('holds on an acceptance of this grant', () => {
    const acceptance = storedAcceptance(ALICE, grantRef(1));
    const input = base({
      userData: true,
      consent: acceptance.ref.uri,
      acceptances: [acceptance],
    });
    expect(consentFailure(input)).toBe(undefined);
    expect(consentHolds(input)).toBe(true);
  });

  it('fails on an acceptance of another grant', () => {
    const acceptance = storedAcceptance(ALICE, grantRef(2));
    expect(
      consentFailure(
        base({
          userData: true,
          consent: acceptance.ref.uri,
          acceptances: [acceptance],
        }),
      ),
    ).toBe('grant-mismatch');
  });

  it('holds on a mutual connection and fails on a single half', () => {
    const [mine, theirs] = mutualConnections(ALICE, AUTHORITY);
    expect(
      consentFailure(
        base({
          newPurpose: true,
          consent: mine.ref.uri,
          connections: [mine, theirs],
        }),
      ),
    ).toBe(undefined);
    expect(
      consentFailure(
        base({ newPurpose: true, consent: mine.ref.uri, connections: [mine] }),
      ),
    ).toBe('not-mutual');
  });

  it('fails as unknown when the reference names no stored record', () => {
    expect(
      consentFailure(base({ userData: true, consent: acceptanceRef(9).uri })),
    ).toBe('unknown-record');
  });
});
