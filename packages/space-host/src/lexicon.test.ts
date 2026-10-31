import {
  Connection,
  GrantAcceptance,
  decodeConnection,
  decodeGrantAcceptance,
} from './consent.js';
import { Effect, Exit, Schema } from 'effect';
import { Grant, GrantRevoke, decodeGrant, decodeGrantRevoke } from './grant.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * The records this package implements, against the lexicons that **publish** them.
 *
 * A record's shape is what clients read: `ing.lexicon.grant` in the lexicon set is the contract, and
 * `grant.ts` is the runtime. They are two descriptions of one record, so this is the check that they
 * say the same thing — and the check has teeth because the decoders are **strict**: a property the
 * lexicon declares and the schema does not is a refusal, not a silently dropped rule.
 *
 * The other direction (a field the schema grew that nobody published) is not caught here. The samples
 * are written to use *every* property the lexicon declares, so the day the lexicon loses one, the
 * comparison below fails.
 */

const HOME = new URL('../../lexicon/lexicons/ing/lexicon/', import.meta.url);

/** The little of a lexicon document this test reads: the record's declared properties. */
const Declared = Schema.Struct({
  id: Schema.String,
  defs: Schema.Record(
    Schema.String,
    Schema.Struct({
      record: Schema.optionalKey(
        Schema.Struct({
          properties: Schema.Record(Schema.String, Schema.Json),
        }),
      ),
    }),
  ),
});

const declared = (name: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Declared))(
    readFileSync(fileURLToPath(new URL(`${name}.json`, HOME)), 'utf-8'),
  );

const propertiesOf = (name: string): ReadonlyArray<string> =>
  Object.keys(declared(name).defs['main']?.record?.properties ?? {});

const DID = 'did:web:pds.lexicon.ing:abc123';
const OTHER = 'did:web:pds.cssints.dev:xyz789';
const AT = '2026-10-14T09:00:00.000Z';

const REF = {
  uri: `at://${DID}/ing.lexicon.grant/3mxr64ihns222`,
  cid: 'bafyreifoy6a6qlbpozbaavgr2yyiwl65oiy2avksmdknbp6g3hwswv5yge',
};

/** A grant that uses **every** property `ing.lexicon.grant` declares. */
const sampleGrant = {
  space: `at://${DID}/ing.lexicon.space/org`,
  subject: OTHER,
  selectors: [{ collection: 'ing.lexicon.space.note' }, { record: REF }],
  actions: ['view', 'write'],
  lens: { nsid: 'ing.lexicon.space.view', cid: REF.cid },
  expiry: AT,
  retention: {
    materialize: 'allowed',
    maxAge: 3600,
    revalidate: true,
    storeUntil: AT,
  },
  purpose: 'notes for the org',
  consent: `at://${OTHER}/ing.lexicon.grant.acceptance/3mxr64j6ib222`,
  issuedBy: DID,
  createdAt: AT,
};

const sampleRevoke = {
  grant: REF,
  revokedAt: AT,
  reason: 'the team changed',
};

const sampleConnection = {
  subject: OTHER,
  connection: REF,
  createdAt: AT,
};

const sampleAcceptance = {
  grant: REF,
  acceptedBy: OTHER,
  acceptedAt: AT,
};

const failed = (effect: Effect.Effect<unknown, unknown, never>) =>
  Effect.runPromiseExit(effect).then(Exit.isFailure);

describe('the space-host records, as published lexicons', () => {
  it('publishes `ing.lexicon.grant` with exactly the properties the schema takes', async () => {
    expect([...propertiesOf('grant')].sort()).toEqual(
      Object.keys(sampleGrant).sort(),
    );
    expect(Object.keys(Grant.fields).sort()).toEqual(
      Object.keys(sampleGrant).sort(),
    );
    await Effect.runPromise(decodeGrant(sampleGrant));
  });

  it('publishes `ing.lexicon.grant.revoke` the same way', async () => {
    expect([...propertiesOf('grant.revoke')].sort()).toEqual(
      Object.keys(sampleRevoke).sort(),
    );
    expect(Object.keys(GrantRevoke.fields).sort()).toEqual(
      Object.keys(sampleRevoke).sort(),
    );
    await Effect.runPromise(decodeGrantRevoke(sampleRevoke));
  });

  it('publishes `ing.lexicon.connection` the same way', async () => {
    expect([...propertiesOf('connection')].sort()).toEqual(
      Object.keys(sampleConnection).sort(),
    );
    expect(Object.keys(Connection.fields).sort()).toEqual(
      Object.keys(sampleConnection).sort(),
    );
    await Effect.runPromise(decodeConnection(sampleConnection));
  });

  it('publishes `ing.lexicon.grant.acceptance` the same way', async () => {
    expect([...propertiesOf('grant.acceptance')].sort()).toEqual(
      Object.keys(sampleAcceptance).sort(),
    );
    expect(Object.keys(GrantAcceptance.fields).sort()).toEqual(
      Object.keys(sampleAcceptance).sort(),
    );
    await Effect.runPromise(decodeGrantAcceptance(sampleAcceptance));
  });

  it('is a check with teeth: a field the lexicon does not name is refused, not dropped', async () => {
    // The whole reason the comparison above means anything. A `deny` is the field this format exists
    // without -- the primitive is positive-only -- and it is a refusal rather than a rule nobody read.
    expect(await failed(decodeGrant({ ...sampleGrant, deny: ['view'] }))).toBe(
      true,
    );
    expect(
      await failed(decodeGrant({ ...sampleGrant, subject: 'not-a-did' })),
    ).toBe(true);
  });
});
