import { type Grant, canView, canViewOf } from './grants.js';
import { describe, expect, it } from 'vitest';

// The grant oracle, one conjunct at a time — because the point of it is that *every* way of
// failing is a refusal, and a table of the failures is the only honest way to test that.

const NOW = new Date('2026-10-12T12:00:00.000Z');

const granted = (over: Partial<Grant> = {}): Grant => ({
  state: 'active',
  subject: 'bob',
  selector: 'did:plc:calendar-org',
  verbs: ['view'],
  ...over,
});

const view = (grant: Grant) =>
  canView({
    grant,
    subjectMatchesViewer: grant.subject === 'bob',
    selectorMatches: grant.selector === 'did:plc:calendar-org',
    now: NOW,
  });

describe('identity: the grant oracle, fail-closed', () => {
  it('allows the case it is for', () => {
    expect(view(granted())).toBe(true);
  });

  it('refuses every way of not being that case', () => {
    // No grant at all.
    expect(view(granted({ state: 'none' }))).toBe(false);
    // Revoked: a grant that existed and stopped.
    expect(view(granted({ state: 'revoked' }))).toBe(false);
    // The wrong subject, even if it matches someone else's.
    expect(
      canView({
        grant: granted({ subject: 'carol' }),
        subjectMatchesViewer: false,
        selectorMatches: true,
        now: NOW,
      }),
    ).toBe(false);
    // The wrong selector: a grant over another calendar is not one over this one.
    expect(
      canView({
        grant: granted({ selector: 'did:plc:other' }),
        subjectMatchesViewer: true,
        selectorMatches: false,
        now: NOW,
      }),
    ).toBe(false);
    // A verb it does not carry: `write` is not `view`.
    expect(view(granted({ verbs: ['write'] }))).toBe(false);
    // Expired, at the moment it expires rather than a moment after.
    expect(view(granted({ until: '2026-10-12T11:59:59.000Z' }))).toBe(false);
    expect(view(granted({ until: '2026-10-12T12:00:00.000Z' }))).toBe(false);
  });

  it('holds a grant until the moment it says, and no longer', () => {
    expect(view(granted({ until: '2026-10-12T12:00:01.000Z' }))).toBe(true);
  });

  it('answers over a set, and a set with nothing in it denies', () => {
    const grants: ReadonlyArray<Grant> = [
      granted({ subject: 'carol' }),
      granted({ selector: 'did:plc:other' }),
      granted({ state: 'revoked' }),
    ];

    // Two grants that nearly apply and one that applied once: none of them is a reason to
    // answer, which is what a free/busy query must not get wrong.
    expect(
      canViewOf({
        grants,
        viewer: 'bob',
        selector: 'did:plc:calendar-org',
        now: NOW,
      }),
    ).toBe(false);
    expect(
      canViewOf({
        grants: [],
        viewer: 'bob',
        selector: 'did:plc:calendar-org',
        now: NOW,
      }),
    ).toBe(false);
    // Add the one that does, and the answer changes — and only for the viewer it names.
    expect(
      canViewOf({
        grants: [...grants, granted()],
        viewer: 'bob',
        selector: 'did:plc:calendar-org',
        now: NOW,
      }),
    ).toBe(true);
    expect(
      canViewOf({
        grants: [...grants, granted()],
        viewer: 'dave',
        selector: 'did:plc:calendar-org',
        now: NOW,
      }),
    ).toBe(false);
  });
});
