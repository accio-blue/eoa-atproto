import {
  ISSUE_STATES,
  IssueCommentSchema,
  IssueLabelOpSchema,
  IssueLabelSchema,
  IssueSchema,
  IssueStateSchema,
} from './model.js';
import { createLexicons, isLexiconDoc } from '../index.js';
import { describe, expect, it } from 'vitest';
import {
  sampleComment,
  sampleIssue,
  sampleLabel,
  sampleLabelOp,
  sampleState,
} from './fixtures.js';
import { Schema } from 'effect';
import { decodeDefsDoc } from '../test-utils.js';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/issue (this file is src/issue).
const HOME = new URL('../../lexicons/ing/lexicon/issue/', import.meta.url);

const NAMES = ['issue', 'state', 'comment', 'label', 'labelOp'] as const;

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`${name}.json`, HOME)), 'utf-8');

const raw = NAMES.map((name) => parseJson(read(name)));
const docs = raw.filter(isLexiconDoc);
// Constructing the registry is the validation: it refuses a document it cannot read as a lexicon.
createLexicons(docs);
const defsDocs = raw.map((one) => decodeDefsDoc(one));

/** The `main` def of one of the five, read through the walking schema. */
const mainOf = (name: (typeof NAMES)[number]) => {
  const id = `ing.lexicon.issue${name === 'issue' ? '' : `.${name}`}`;
  const def = defsDocs.find((one) => one.id === id)?.defs['main'];
  if (def === undefined) {
    throw new Error(`no main def for ${id}`);
  }
  return def;
};

/** The sample each record is walked with, and nothing else: the schemas are decoded below. */
const samples = [
  ['issue', sampleIssue],
  ['state', sampleState],
  ['comment', sampleComment],
  ['label', sampleLabel],
  ['labelOp', sampleLabelOp],
] as const;

describe('the issue surface lexicons', () => {
  it('are five valid lexicon documents in one namespace', () => {
    expect(docs).toHaveLength(NAMES.length);
    expect(docs.map((one) => one.id).sort()).toEqual([
      'ing.lexicon.issue',
      'ing.lexicon.issue.comment',
      'ing.lexicon.issue.label',
      'ing.lexicon.issue.labelOp',
      'ing.lexicon.issue.state',
    ]);
  });

  it('describe records keyed by tid, like every append-only record here', () => {
    for (const name of NAMES) {
      expect(mainOf(name).type).toBe('record');
      expect(mainOf(name).key).toBe('tid');
    }
  });

  it('accept the samples the schemas accept, field for field', () => {
    // Each sample decodes, so schema and JSON agree on types...
    expect(() =>
      Schema.decodeUnknownSync(IssueSchema)(sampleIssue),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(IssueStateSchema)(sampleState),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(IssueCommentSchema)(sampleComment),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(IssueLabelSchema)(sampleLabel),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(IssueLabelOpSchema)(sampleLabelOp),
    ).not.toThrow();

    // ...and the fields are the same set: a property in one and not the other fails here. `$type`
    // is the one exception, because a record carries it and a lexicon never declares it.
    for (const [name, sample] of samples) {
      expect(
        Object.keys(sample)
          .filter((key) => key !== '$type')
          .sort(),
      ).toEqual(Object.keys(mainOf(name).properties ?? {}).sort());
    }
  });

  it('keep the four states the machine rules on, and no fifth', () => {
    // The lexicon states the names for readers; the machine rules on which moves are legal. They
    // are one list, and this is what keeps them one list.
    expect(mainOf('state').properties?.['state']?.knownValues).toEqual([
      ...ISSUE_STATES,
    ]);
  });

  it('point at what they refer to with a ref, not a bare uri', () => {
    for (const name of ['state', 'comment', 'labelOp'] as const) {
      expect(mainOf(name).properties?.['subject']?.type).toBe('ref');
      expect(mainOf(name).properties?.['subject']?.ref).toBe(
        'ing.lexicon.cms.defs#strongRef',
      );
    }
  });
});
