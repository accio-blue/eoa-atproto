import {
  CI_OUTCOMES,
  CI_RUN_NSID,
  CI_STATUSES,
  CiRunSchema,
  outcomeOf,
} from './model.js';
import { createLexicons, isLexiconDoc } from '../index.js';
import { describe, expect, it } from 'vitest';
import { sampleQueued, sampleRun } from './fixtures.js';
import { Schema } from 'effect';
import { decodeDefsDoc } from '../test-utils.js';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/ci (this file is src/ci).
const HOME = new URL('../../lexicons/ing/lexicon/ci/', import.meta.url);

const doc = parseJson(
  readFileSync(fileURLToPath(new URL('run.json', HOME)), 'utf-8'),
);
// Constructing the registry is the validation: it refuses a document it cannot read as a lexicon.
createLexicons([doc].filter(isLexiconDoc));
const main = decodeDefsDoc(doc).defs['main'];
if (main === undefined) {
  throw new Error('no main def for ing.lexicon.ci.run');
}

describe('the CI run lexicon', () => {
  it('is a valid record in its own namespace, keyed by the run, not by an order', () => {
    expect(isLexiconDoc(doc) && doc.id).toBe(CI_RUN_NSID);
    expect(main.type).toBe('record');
    // A run's key names the machine that ran it; an order would imply a log this record is not.
    expect(main.key).toBe('any');
  });

  it('accepts the samples the schema accepts, field for field', () => {
    expect(() =>
      Schema.decodeUnknownSync(CiRunSchema)(sampleRun),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CiRunSchema)(sampleQueued),
    ).not.toThrow();
    // The two are one set of fields: every key a sample carries is declared, and every required
    // property is there. `$type` is the one exception — a record carries it, a lexicon never
    // declares it.
    const declared = Object.keys(main.properties ?? {});
    for (const sample of [sampleRun, sampleQueued]) {
      for (const key of Object.keys(sample)) {
        if (key !== '$type') {
          expect(declared).toContain(key);
        }
      }
    }
    for (const key of main.required ?? []) {
      expect(Object.keys(sampleRun)).toContain(key);
    }
  });

  it('states the statuses and outcomes the schema knows, and no fifth', () => {
    expect(main.properties?.['status']?.knownValues).toEqual([...CI_STATUSES]);
    expect(main.properties?.['outcome']?.knownValues).toEqual([...CI_OUTCOMES]);
  });

  it('earns an outcome only when the machine is done', () => {
    // Not done, no verdict.
    expect(
      outcomeOf({ status: 'queued', exitCode: undefined, refused: false }),
    ).toBeUndefined();
    expect(
      outcomeOf({ status: 'running', exitCode: 0, refused: false }),
    ).toBeUndefined();
    // A command's own exit code decides between passed and failed...
    expect(outcomeOf({ status: 'done', exitCode: 0, refused: false })).toBe(
      'passed',
    );
    expect(outcomeOf({ status: 'done', exitCode: 1, refused: false })).toBe(
      'failed',
    );
    // ...and a run that never ran did not fail the commit: the CI did.
    expect(
      outcomeOf({ status: 'done', exitCode: undefined, refused: false }),
    ).toBe('error');
    expect(outcomeOf({ status: 'done', exitCode: 0, refused: true })).toBe(
      'error',
    );
  });
});
