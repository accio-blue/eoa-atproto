import {
  COMPONENT_NSID,
  EXTERNAL_BODY,
  NSID_PATTERN,
  OVERRIDE_NSID,
  PREFS_NSID,
  PRIMITIVE_NSID,
  SCENE_NSID,
  TEMPLATE_BODY,
} from './index.js';
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Predicate } from 'effect';
import { fileURLToPath } from 'node:url';
import { parseJson } from './json.js';

/**
 * One namespace root, everywhere. The domain is `lexicon.ing`, so every NSID
 * is `ing.lexicon.*`. A published lexicon's NSID can never change, so this test
 * is the tripwire: it fails the moment a document or a constant uses another
 * root, which is exactly the mistake that is free to make today and expensive
 * after the first publish.
 */
const ROOT = 'ing.lexicon.';

const HOME = new URL('../lexicons/', import.meta.url);

const documents = (): ReadonlyArray<{
  readonly file: string;
  readonly doc: unknown;
}> =>
  readdirSync(fileURLToPath(HOME), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => ({
      file: entry,
      doc: parseJson(readFileSync(new URL(entry, HOME), 'utf-8')),
    }));

/** Every `id`, `ref` and `refs[]` string in a document, which are the NSID slots. */
const nsidsOf = (doc: unknown): readonly string[] => {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!Predicate.isObjectOrArray(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'id' || key === 'ref') {
        if (typeof child === 'string') found.push(child);
      } else if (key === 'refs') {
        if (Array.isArray(child))
          child.forEach((ref) => {
            if (typeof ref === 'string') found.push(ref);
          });
      } else {
        walk(child);
      }
    }
  };
  walk(doc);
  return found;
};

describe('the lexicon namespace', () => {
  it('is ing.lexicon for every document id', () => {
    const docs = documents();
    expect(docs.length).toBeGreaterThan(0);
    for (const { file, doc } of docs) {
      const id =
        Predicate.hasProperty(doc, 'id') && typeof doc.id === 'string'
          ? doc.id
          : '';
      expect(`${file} -> ${id}`, file).toContain(ROOT);
      expect(id.startsWith(ROOT)).toBe(true);
    }
  });

  it('is ing.lexicon for every ref that names a full NSID', () => {
    for (const { file, doc } of documents()) {
      for (const nsid of nsidsOf(doc)) {
        // A local ref (`#nodeOverride`) is not an NSID and carries no root.
        if (nsid.startsWith('#')) continue;
        expect(`${file} -> ${nsid}`).toContain(ROOT);
      }
    }
  });

  it('matches the atproto NSID syntax, name segment included', () => {
    for (const { file, doc } of documents()) {
      for (const nsid of nsidsOf(doc)) {
        // A ref may carry a definition fragment (`…#node`); the NSID is the part before it.
        const target = nsid.split('#')[0] ?? '';
        if (target === '') continue;
        expect(target, `${file} -> ${nsid}`).toMatch(NSID_PATTERN);
      }
    }
  });

  it('is ing.lexicon for every exported constant', () => {
    for (const nsid of [
      COMPONENT_NSID,
      EXTERNAL_BODY,
      TEMPLATE_BODY,
      OVERRIDE_NSID,
      PREFS_NSID,
      PRIMITIVE_NSID,
      SCENE_NSID,
    ]) {
      expect(nsid.startsWith(ROOT)).toBe(true);
    }
  });
});
