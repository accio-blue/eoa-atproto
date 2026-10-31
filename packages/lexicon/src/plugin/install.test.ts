import { PLUGIN_INSTALL_NSID } from './install.js';
import { Schema } from 'effect';
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
  }),
});
const doc = Schema.decodeUnknownSync(Schema.fromJsonString(DocSchema), {
  onExcessProperty: 'ignore',
})(readFileSync(new URL('install.json', HOME), 'utf8'));

describe('the plugin install record', () => {
  it('is keyed by the plugin, so an account has one install per plugin', () => {
    expect(doc.id).toBe(PLUGIN_INSTALL_NSID);
    expect(doc.defs.main.type).toBe('record');
    expect(doc.defs.main.key).toBe('any');
    expect(doc.defs.main.record.required).toEqual([
      'plugin',
      'version',
      'release',
      'grants',
      'createdAt',
    ]);
  });

  it('names the release it was verified against, and the grants the tenant gave', () => {
    expect(doc.defs.main.record.properties['plugin']?.format).toBe('nsid');
    expect(doc.defs.main.record.properties['release']?.format).toBe('at-uri');
    expect(doc.defs.main.record.properties['grants']?.type).toBe('array');
  });
});
