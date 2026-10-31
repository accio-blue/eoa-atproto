import { parseJson, stringifyJson } from './json.js';
import { Schema } from 'effect';
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

export const loadFixture = (path: string): Schema.Json => {
  const fullPath = join(FIXTURES_DIR, path);
  const content = readFileSync(fullPath, 'utf-8');
  return parseJson(content);
};

/** A typed view of a lexicon def, for tests that walk the JSON. */
export interface Def {
  readonly type: string;
  readonly properties?: Readonly<Record<string, Def>>;
  readonly required?: readonly string[];
  readonly items?: Def;
  readonly ref?: string;
  readonly refs?: readonly string[];
  readonly closed?: boolean;
  readonly record?: Def;
  readonly key?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: string;
  /** A closed set of strings the lexicon *documents*; nothing enforces it at runtime. */
  readonly knownValues?: readonly string[];
}

export const DefSchema: Schema.Codec<Def> = Schema.Struct({
  type: Schema.String,
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend((): Schema.Codec<Def> => DefSchema),
    ),
  ),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(Schema.suspend((): Schema.Codec<Def> => DefSchema)),
  ref: Schema.optionalKey(Schema.String),
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
  closed: Schema.optionalKey(Schema.Boolean),
  record: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<Def> => DefSchema),
  ),
  key: Schema.optionalKey(Schema.String),
  minLength: Schema.optionalKey(Schema.Number),
  maxLength: Schema.optionalKey(Schema.Number),
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number),
  format: Schema.optionalKey(Schema.String),
  knownValues: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const DefsDocSchema = Schema.Struct({
  id: Schema.String,
  defs: Schema.Record(Schema.String, DefSchema),
});
export type DefsDoc = typeof DefsDocSchema.Type;

export const decodeDefsDoc = Schema.decodeUnknownSync(DefsDocSchema);

const decodePlain = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Json),
);

/** A JSON round trip: drops `undefined` fields, as a stored record would. */
export const plain = <T>(value: T): { readonly [key: string]: Schema.Json } =>
  decodePlain(parseJson(stringifyJson(value)));
