import {
  MERGE_REQUEST_NSID,
  MERGE_REQUEST_STATE_NSID,
  MERGE_STATES,
  MergeRequestSchema,
  MergeStateSchema,
} from './merge-request.js';
import { createLexicons, isLexiconDoc } from '../index.js';
import { describe, expect, it } from 'vitest';
import {
  sampleClosed,
  sampleMergeRequest,
  sampleMerged,
} from './fixtures.js';
import { Schema } from 'effect';
import { decodeDefsDoc } from '../test-utils.js';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/git (this file is src/git).
const HOME = new URL('../../lexicons/ing/lexicon/git/', import.meta.url);
const read = (path: string): Schema.Json =>
  parseJson(readFileSync(fileURLToPath(new URL(path, HOME)), 'utf-8'));

const docs = [read('mergeRequest.json'), read('mergeRequest/state.json')];
// Constructing the registry is the validation: it refuses a document it cannot read as a lexicon.
createLexicons(docs.filter(isLexiconDoc));
const mainOf = (doc: Schema.Json) => decodeDefsDoc(doc).defs['main'];

describe('the merge request lexicons', () => {
  it('are two valid documents in one namespace, keyed by tid', () => {
    const ids: string[] = [];
    for (const doc of docs) {
      if (isLexiconDoc(doc)) {
        ids.push(doc.id);
      }
    }
    expect(ids.sort()).toEqual([MERGE_REQUEST_NSID, MERGE_REQUEST_STATE_NSID]);
    for (const doc of docs) {
      expect(mainOf(doc)?.type).toBe('record');
      expect(mainOf(doc)?.key).toBe('tid');
    }
  });

  it('accept the samples the schemas accept, field for field', () => {
    expect(() =>
      Schema.decodeUnknownSync(MergeRequestSchema)(sampleMergeRequest),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MergeStateSchema)(sampleMerged),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MergeStateSchema)(sampleClosed),
    ).not.toThrow();
    for (const sample of [sampleMerged, sampleClosed]) {
      for (const key of Object.keys(sample)) {
        if (key !== '$type') {
          expect(Object.keys(mainOf(docs[1])?.properties ?? {})).toContain(key);
        }
      }
    }
    for (const key of Object.keys(sampleMergeRequest)) {
      if (key !== '$type') {
        expect(Object.keys(mainOf(docs[0])?.properties ?? {})).toContain(key);
      }
    }
  });

  it('keeps the three states, and no fourth', () => {
    expect(mainOf(docs[1])?.properties?.['state']?.knownValues).toEqual([
      ...MERGE_STATES,
    ]);
  });
});
