import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

const FIXTURES_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'atproto-interop',
);

export const loadFixture = <T = unknown>(path: string): T => {
  const fullPath = join(FIXTURES_DIR, path);
  const content = readFileSync(fullPath, 'utf-8');
  return JSON.parse(content) as T;
};
