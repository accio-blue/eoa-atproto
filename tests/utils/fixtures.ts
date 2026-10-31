import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// `tests/utils` is a shared test library, not a vitest project of its own.
// The root `vite.config.ts` only collects suites from `apps/**`, `packages/**`
// and `tools/**`, so nothing here runs standalone: package tests import these
// helpers by relative path.
//
// ESM-safe: derive the directory from `import.meta.url` instead of
// `__dirname`, which does not exist in ES modules.
const UTILS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(UTILS_DIR, '..', 'fixtures', 'atproto-interop');

const resolveFixturePath = (path: string): string => {
  const fullPath = resolve(FIXTURES_DIR, path);
  const relativePath = relative(FIXTURES_DIR, fullPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Fixture path escapes the fixtures directory: ${path}`);
  }

  return fullPath;
};

// Load and parse a JSON fixture from `tests/fixtures/atproto-interop`.
// Callers supply the expected shape: `loadFixture<LexiconDoc>('lexicon/...')`.
export const loadFixture = <T = unknown>(path: string): T => {
  const content = readFileSync(resolveFixturePath(path), 'utf8');
  return JSON.parse(content) as T;
};

// Load a fixture verbatim, without parsing.
export const loadTextFixture = (path: string): string =>
  readFileSync(resolveFixturePath(path), 'utf8');

const isIgnoredSyntaxLine = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//');
};

// Parse a syntax fixture into one entry per line. Blank lines and `#` / `//`
// comments are dropped. Leading and trailing whitespace is intentionally
// preserved: some fixtures encode invalid values using stray spaces.
export const parseSyntaxFixture = (content: string): string[] =>
  content.split(/\r?\n/).filter((line) => !isIgnoredSyntaxLine(line));

// Load `syntax/<kind>.txt` as a list of values. `kind` may include the `.txt`
// suffix, e.g. `loadSyntaxFixture('did_syntax_valid')` or
// `loadSyntaxFixture('nsid_syntax_invalid.txt')`.
export const loadSyntaxFixture = (kind: string): string[] => {
  const fileName = kind.endsWith('.txt') ? kind : `${kind}.txt`;
  return parseSyntaxFixture(loadTextFixture(join('syntax', fileName)));
};
