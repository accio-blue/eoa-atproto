import { describe, expect, it } from 'vitest';
import { PLUGIN_RELEASE_NSID } from './release.js';
import { Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/plugin (this file is src/plugin).
const HOME = new URL('../../lexicons/ing/lexicon/plugin/', import.meta.url);
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
            format: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    }),
    artifact: Schema.Struct({
      required: Schema.Array(Schema.String),
      properties: Schema.Record(
        Schema.String,
        Schema.Struct({
          type: Schema.optionalKey(Schema.String),
          minimum: Schema.optionalKey(Schema.Number),
        }),
      ),
    }),
  }),
});
const doc = Schema.decodeUnknownSync(Schema.fromJsonString(DocSchema))(
  readFileSync(fileURLToPath(new URL('release.json', HOME)), 'utf-8'),
);

describe('the plugin release record', () => {
  it('is keyed by tid and names the bundle and the plugin', () => {
    expect(doc.id).toBe(PLUGIN_RELEASE_NSID);
    expect(doc.defs.main.type).toBe('record');
    expect(doc.defs.main.key).toBe('tid');
    expect(doc.defs.main.record.required).toEqual([
      'plugin',
      'version',
      'cid',
      'artifact',
      'createdAt',
    ]);
    expect(doc.defs.main.record.properties['plugin']?.format).toBe('nsid');
    expect(doc.defs.main.record.properties['cid']?.format).toBe('cid');
  });

  it('requires the artifact checksum and allows a size', () => {
    expect(doc.defs.artifact.required).toEqual(['sha256']);
    expect(doc.defs.artifact.properties['sha256']?.type).toBe('string');
    expect(doc.defs.artifact.properties['size']?.minimum).toBe(0);
  });
});
