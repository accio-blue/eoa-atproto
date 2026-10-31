import {
  EVENT_PAYLOADS,
  LOOK_INTENTS,
  PRIMITIVE_NSID,
  PROP_TYPES,
  declaresEvent,
  declaresProp,
  unknownIntents,
} from './primitive.js';
import { createLexicons, isLexiconDoc } from '../index.js';
import { describe, expect, it } from 'vitest';
import type { PrimitiveRecord } from './primitive.js';
import { Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/ui (this file is src/ui).
const HOME = new URL('../../lexicons/ing/lexicon/ui/', import.meta.url);
const PropSchema = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  knownValues: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(
    Schema.Struct({
      knownValues: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
const ViewSchema = Schema.Struct({
  id: Schema.String,
  defs: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      key: Schema.optionalKey(Schema.String),
      required: Schema.optionalKey(Schema.Array(Schema.String)),
      record: Schema.optionalKey(
        Schema.Struct({
          properties: Schema.optionalKey(
            Schema.Record(Schema.String, PropSchema),
          ),
        }),
      ),
      properties: Schema.optionalKey(Schema.Record(Schema.String, PropSchema)),
    }),
  ),
});
const raw = parseJson(
  readFileSync(fileURLToPath(new URL('primitive.json', HOME)), 'utf-8'),
);
const doc = Schema.decodeUnknownSync(ViewSchema)(raw);
const lexiconDocs = [raw].filter(isLexiconDoc);

// The 33 intents, constructed rather than copied, so the list is checked not just trusted.
const COLOUR = ['background', 'foreground', 'border'];
const TEXT = ['size', 'weight', 'family', 'lineHeight'];
const canonical = [
  ...COLOUR.map((aspect) => `control.${aspect}`),
  ...['action', 'surface'].flatMap((group) =>
    ['primary', 'secondary', 'auxiliary'].flatMap((priority) =>
      COLOUR.map((aspect) => `${group}.${priority}.${aspect}`),
    ),
  ),
  ...['primary', 'secondary', 'auxiliary'].flatMap((priority) =>
    TEXT.map((aspect) => `text.${priority}.${aspect}`),
  ),
].sort();

const record = (patch: Partial<PrimitiveRecord> = {}): PrimitiveRecord => ({
  $type: PRIMITIVE_NSID,
  nsid: 'ing.lexicon.ui.disclosure',
  createdAt: '2026-10-08T00:00:00.000Z',
  ...patch,
});

describe('the primitive interface lexicon', () => {
  it('is a lexicon doc the toolkit registry accepts, keyed by the primitive NSID', () => {
    expect(isLexiconDoc(raw)).toBe(true);
    expect(createLexicons(lexiconDocs)).toBeDefined();
    expect(doc.id).toBe(PRIMITIVE_NSID);
    expect(doc.defs.main?.type).toBe('record');
    expect(doc.defs.main?.key).toBe('nsid');
  });

  it('accepts exactly the prop and event shapes the mirror declares', () => {
    expect(doc.defs.propDecl?.properties?.type?.knownValues).toEqual([
      ...PROP_TYPES,
    ]);
    expect(doc.defs.eventDecl?.properties?.payload?.knownValues).toEqual([
      ...EVENT_PAYLOADS,
    ]);
  });
});

describe('the standard intents', () => {
  it('are the 33 of the standard: 21 colour and 12 typography', () => {
    expect(LOOK_INTENTS).toHaveLength(33);
    expect([...LOOK_INTENTS].sort()).toEqual(canonical);
    expect(canonical.filter((name) => name.startsWith('text.'))).toHaveLength(
      12,
    );
  });

  it('cannot drift from the lexicon: the knownValues match the mirror exactly', () => {
    expect(
      doc.defs.main?.record?.properties?.lookIntents?.items?.knownValues,
    ).toEqual([...LOOK_INTENTS]);
  });
});

describe('the record helpers', () => {
  it('answer whether a prop or event is declared', () => {
    const value = record({
      props: [
        { name: 'defaultExpanded', type: 'boolean' },
        { name: 'disabled', type: 'boolean' },
      ],
      events: [{ name: 'onExpandedChange', payload: 'boolean' }],
    });
    expect(declaresProp({ record: value, name: 'defaultExpanded' })).toBe(true);
    expect(declaresProp({ record: value, name: 'open' })).toBe(false);
    expect(declaresEvent({ record: value, name: 'onExpandedChange' })).toBe(
      true,
    );
    expect(declaresEvent({ record: value, name: 'onToggle' })).toBe(false);
    expect(declaresProp({ record: record(), name: 'anything' })).toBe(false);
  });

  it('report an intent outside the standard, so a look cannot paint what was not declared', () => {
    expect(
      unknownIntents(record({ lookIntents: ['control.background'] })),
    ).toEqual([]);
    expect(unknownIntents(record())).toEqual([]);
    expect(
      unknownIntents(
        record({
          // An intent outside the standard is what is under test, so the static
          // type is deliberately violated here.
          // oxlint-disable-next-line automation/no-type-assertion, automation/no-banned-type-assertions
          lookIntents: ['control.background', 'ui.mine.glow'] as never,
        }),
      ),
    ).toEqual(['ui.mine.glow']);
  });
});
