import { Effect, Exit, Schema } from 'effect';
import { REGISTRY_MANIFEST_NSID, REGISTRY_MODULE_TYPES } from './manifest.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { validateWithLexicon } from '../index.js';

// Home: packages/lexicon/lexicons/ing/lexicon/registry (this file is src/registry).
const HOME = new URL('../../lexicons/ing/lexicon/registry/', import.meta.url);
const DocSchema = Schema.Struct({
  id: Schema.String,
  defs: Schema.Struct({
    main: Schema.Struct({
      type: Schema.String,
      key: Schema.String,
      record: Schema.Struct({
        required: Schema.Array(Schema.String),
        properties: Schema.Record(
          Schema.String,
          Schema.Struct({
            type: Schema.optionalKey(Schema.String),
            items: Schema.optionalKey(
              Schema.Struct({ ref: Schema.optionalKey(Schema.String) }),
            ),
          }),
        ),
      }),
    }),
    module: Schema.Struct({
      required: Schema.Array(Schema.String),
      properties: Schema.Record(
        Schema.String,
        Schema.Struct({
          knownValues: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  }),
});
const doc = Schema.decodeUnknownSync(Schema.fromJsonString(DocSchema))(
  readFileSync(fileURLToPath(new URL('manifest.json', HOME)), 'utf-8'),
);

describe('the registry manifest record', () => {
  it('is a per-repo singleton with inline module entries', () => {
    expect(doc.id).toBe(REGISTRY_MANIFEST_NSID);
    expect(doc.defs.main.type).toBe('record');
    expect(doc.defs.main.key).toBe('literal:self');
    expect(doc.defs.main.record.required).toEqual(['modules']);
    expect(doc.defs.main.record.properties['modules']?.items?.ref).toBe(
      '#module',
    );
  });

  it('requires the pin fields on every module', () => {
    expect(doc.defs.module.required).toEqual(['id', 'version', 'cid', 'type']);
  });

  it('declares the closed set and a string type the toolkit enforces', async () => {
    const knownValues = doc.defs.module.properties['type']?.knownValues ?? [];
    expect(knownValues).toEqual([...REGISTRY_MODULE_TYPES]);

    const run = (value: string | number) =>
      Effect.runPromiseExit(
        validateWithLexicon({ data: value, lexicon: { type: 'string' } }),
      );
    expect(Exit.isSuccess(await run('tool'))).toBe(true);
    expect(Exit.isFailure(await run(42))).toBe(true);
  });
});
