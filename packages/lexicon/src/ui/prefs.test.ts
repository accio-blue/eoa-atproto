import { Effect, Exit, Schema } from 'effect';
import { PREFS_NSID, UI_PREF_DEFAULTS, resolvePrefs } from './prefs.js';
import { describe, expect, it } from 'vitest';
import type { UiPrefsRecord } from './prefs.js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { stringifyJson } from '../json.js';
import { validateWithLexicon } from '../index.js';

// Home: packages/lexicon/lexicons/ing/lexicon/ui (this file is src/ui).
const HOME = new URL('../../lexicons/ing/lexicon/ui/', import.meta.url);
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
            type: Schema.String,
            knownValues: Schema.optionalKey(Schema.Array(Schema.String)),
            minimum: Schema.optionalKey(Schema.Number),
          }),
        ),
      }),
    }),
  }),
});
const doc = Schema.decodeUnknownSync(Schema.fromJsonString(DocSchema))(
  readFileSync(fileURLToPath(new URL('prefs.json', HOME)), 'utf-8'),
);

const sample: UiPrefsRecord = {
  $type: PREFS_NSID,
  createdAt: '2026-10-07T00:00:00.000Z',
  motion: 'reduce',
  tooltipShowDelayMs: 750,
};

describe('the prefs record', () => {
  it('is a per-repo singleton record with only optional preferences', () => {
    expect(doc.id).toBe(PREFS_NSID);
    expect(doc.defs.main.type).toBe('record');
    expect(doc.defs.main.key).toBe('literal:self');
    expect(doc.defs.main.record.required).toEqual(['createdAt']);
    expect(doc.defs.main.record.properties.motion?.knownValues).toEqual([
      'system',
      'reduce',
      'full',
    ]);
  });

  it('keeps every duration an integer, which the toolkit enforces', async () => {
    for (const field of [
      'motionDurationMs',
      'typeaheadDelayMs',
      'tooltipShowDelayMs',
      'tooltipHideDelayMs',
    ]) {
      const property = doc.defs.main.record.properties[field];
      expect(property?.type).toBe('integer');
      const run = (value: number) =>
        Effect.runPromiseExit(
          validateWithLexicon({ data: value, lexicon: { type: 'integer' } }),
        );
      expect(Exit.isSuccess(await run(property?.minimum ?? 0))).toBe(true);
      expect(Exit.isFailure(await run(1.5))).toBe(true);
    }
  });
});

describe('resolvePrefs', () => {
  it('returns the defaults when there is no record', () => {
    expect(resolvePrefs({ record: undefined })).toEqual(UI_PREF_DEFAULTS);
  });

  it('merges a partial record over the defaults', () => {
    const resolved = resolvePrefs({ record: sample });
    expect(resolved).toEqual({
      ...UI_PREF_DEFAULTS,
      motion: 'reduce',
      motionDurationMs: 0,
      tooltipShowDelayMs: 750,
    });
  });

  it('follows prefers-reduced-motion when motion is system', () => {
    expect(
      resolvePrefs({ record: undefined, system: { reducedMotion: true } })
        .motion,
    ).toBe('reduce');
    expect(
      resolvePrefs({ record: undefined, system: { reducedMotion: false } })
        .motion,
    ).toBe('full');
  });

  it('lets an explicit motion preference beat the system one', () => {
    const full = resolvePrefs({
      record: { ...sample, motion: 'full' },
      system: { reducedMotion: true },
    });
    expect(full.motion).toBe('full');
    expect(full.motionDurationMs).toBe(UI_PREF_DEFAULTS.motionDurationMs);
  });

  it('makes reduced motion a jump whatever the record asked for', () => {
    const resolved = resolvePrefs({
      record: { ...sample, motionDurationMs: 900 },
      system: { reducedMotion: true },
    });
    expect(resolved.motion).toBe('reduce');
    expect(resolved.motionDurationMs).toBe(0);
  });

  it('is defensive about an untrusted record', () => {
    const resolved = resolvePrefs({
      record: {
        $type: PREFS_NSID,
        createdAt: '2026-10-07T00:00:00.000Z',
        // Untrusted data off the network is exactly what is under test, so the
        // static type is deliberately violated here.
        // oxlint-disable-next-line automation/no-type-assertion, automation/no-banned-type-assertions
        motion: 'wobble' as never,
        tooltipShowDelayMs: -40,
        typeaheadDelayMs: 12.9,
        // oxlint-disable-next-line automation/no-type-assertion, automation/no-banned-type-assertions
        announce: 'no' as never,
      },
    });
    expect(resolved.motion).toBe('full');
    expect(resolved.tooltipShowDelayMs).toBe(0);
    expect(resolved.typeaheadDelayMs).toBe(12);
    expect(resolved.announce).toBe(true);
  });

  it('does not mutate the record it is given', () => {
    const record = { ...sample };
    const before = stringifyJson(record);
    resolvePrefs({ record });
    expect(stringifyJson(record)).toBe(before);
  });
});
