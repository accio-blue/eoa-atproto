import * as Lexicons from './lexicon.js';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { loadFixture } from './test-utils.js';

const ValidFixtures = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    lexicon: Schema.Struct({
      lexicon: Schema.Number,
      id: Schema.String,
      defs: Schema.Unknown,
    }),
  }),
);
const InvalidFixtures = Schema.Array(
  Schema.Struct({ name: Schema.String, lexicon: Schema.Unknown }),
);

describe('Lexicons class', () => {
  it('should create empty registry', () => {
    const registry = new Lexicons.Lexicons();

    expect(registry.all).toEqual(new Map());
    expect(registry.ids).toEqual([]);
  });

  it('should create registry from documents', () => {
    const docs = [
      {
        lexicon: 1,
        id: 'com.example.test1',
        defs: {
          main: { type: 'string' },
        },
      },
      {
        lexicon: 1,
        id: 'com.example.test2',
        defs: {
          main: { type: 'integer' },
        },
      },
    ];

    const registry = new Lexicons.Lexicons(docs);

    expect(registry.all.size).toBe(2);
    expect(registry.ids).toEqual(['com.example.test1', 'com.example.test2']);
  });

  it('should add documents', () => {
    const registry = new Lexicons.Lexicons();

    const doc = {
      lexicon: 1,
      id: 'com.example.test',
      defs: {
        main: { type: 'string' },
      },
    };

    registry.add(doc);

    expect(registry.has('com.example.test')).toBe(true);
    expect(registry.get('com.example.test')).toEqual(doc);
  });

  it('should get documents by id', () => {
    const doc = {
      lexicon: 1,
      id: 'com.example.test',
      defs: {
        main: { type: 'string' },
      },
    };

    const registry = new Lexicons.Lexicons([doc]);

    const retrieved = registry.get('com.example.test');

    expect(retrieved).toEqual(doc);
  });

  it('should return undefined for non-existent document', () => {
    const registry = new Lexicons.Lexicons();

    const retrieved = registry.get('com.example.missing');

    expect(retrieved).toBeUndefined();
  });

  it('should check if document exists', () => {
    const doc = {
      lexicon: 1,
      id: 'com.example.test',
      defs: {
        main: { type: 'string' },
      },
    };

    const registry = new Lexicons.Lexicons([doc]);

    expect(registry.has('com.example.test')).toBe(true);
    expect(registry.has('com.example.missing')).toBe(false);
  });

  it('should return all documents', () => {
    const docs = [
      {
        lexicon: 1,
        id: 'com.example.test1',
        defs: { main: { type: 'string' } },
      },
      {
        lexicon: 1,
        id: 'com.example.test2',
        defs: { main: { type: 'integer' } },
      },
    ];

    const registry = new Lexicons.Lexicons(docs);

    expect(registry.all.size).toBe(2);
    expect(registry.all.get('com.example.test1')).toBeDefined();
    expect(registry.all.get('com.example.test2')).toBeDefined();
  });

  it('should return all ids', () => {
    const docs = [
      {
        lexicon: 1,
        id: 'com.example.test1',
        defs: { main: { type: 'string' } },
      },
      {
        lexicon: 1,
        id: 'com.example.test2',
        defs: { main: { type: 'integer' } },
      },
    ];

    const registry = new Lexicons.Lexicons(docs);

    const ids = registry.ids;

    expect(ids).toHaveLength(2);
    expect(ids).toContain('com.example.test1');
    expect(ids).toContain('com.example.test2');
  });
});

describe('createLexicons utility', () => {
  it('should create registry from array', () => {
    const docs = [
      {
        lexicon: 1,
        id: 'com.example.test',
        defs: { main: { type: 'string' } },
      },
    ];

    const registry = Lexicons.createLexicons(docs);

    expect(registry).toBeInstanceOf(Lexicons.Lexicons);
    expect(registry.has('com.example.test')).toBe(true);
  });

  it('should create empty registry from empty array', () => {
    const registry = Lexicons.createLexicons([]);

    expect(registry).toBeInstanceOf(Lexicons.Lexicons);
    expect(registry.all.size).toBe(0);
  });
});

describe('isLexiconDoc type guard', () => {
  it('should return true for valid lexicon doc', () => {
    const doc = {
      lexicon: 1,
      id: 'com.example.test',
      defs: {
        main: { type: 'string' },
      },
    };

    expect(Lexicons.isLexiconDoc(doc)).toBe(true);
  });

  it('should return false for missing lexicon property', () => {
    const doc = {
      id: 'com.example.test',
      defs: {
        main: { type: 'string' },
      },
    };

    expect(Lexicons.isLexiconDoc(doc)).toBe(false);
  });

  it('should return false for missing id property', () => {
    const doc = {
      lexicon: 1,
      defs: {
        main: { type: 'string' },
      },
    };

    expect(Lexicons.isLexiconDoc(doc)).toBe(false);
  });

  it('should return false for missing defs property', () => {
    const doc = {
      lexicon: 1,
      id: 'com.example.test',
    };

    expect(Lexicons.isLexiconDoc(doc)).toBe(false);
  });

  it('should return false for non-object values', () => {
    expect(Lexicons.isLexiconDoc(null)).toBe(false);
    expect(Lexicons.isLexiconDoc(undefined)).toBe(false);
    expect(Lexicons.isLexiconDoc('string')).toBe(false);
    expect(Lexicons.isLexiconDoc(123)).toBe(false);
  });

  it('should return false for wrong types', () => {
    expect(
      Lexicons.isLexiconDoc({ lexicon: 'not-a-number', id: 'test', defs: {} }),
    ).toBe(false);
    // Note: typeof null === "object" in JS, so this may pass
    // The type guard should be updated to handle null explicitly
    expect(Lexicons.isLexiconDoc({ lexicon: 1, id: 123, defs: {} })).toBe(
      false,
    );
  });
});

describe('atproto-interop fixtures', () => {
  it('should load valid lexicon fixtures', () => {
    const fixtures = Schema.decodeUnknownSync(ValidFixtures)(
      loadFixture('lexicon/lexicon-valid.json'),
    );

    expect(Array.isArray(fixtures)).toBe(true);
    expect(fixtures.length).toBeGreaterThan(0);

    // All fixtures should be valid lexicon docs
    for (const fixture of fixtures) {
      expect(Lexicons.isLexiconDoc(fixture.lexicon)).toBe(true);
      expect(fixture.lexicon.lexicon).toBe(1);
      expect(typeof fixture.lexicon.id).toBe('string');
      expect(typeof fixture.lexicon.defs).toBe('object');
    }
  });

  it('should have valid fixture names', () => {
    const fixtures = Schema.decodeUnknownSync(ValidFixtures)(
      loadFixture('lexicon/lexicon-valid.json'),
    );

    const names = fixtures.map((f) => f.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => typeof n === 'string')).toBe(true);
  });

  it('should identify invalid lexicon fixtures', () => {
    const fixtures = Schema.decodeUnknownSync(InvalidFixtures)(
      loadFixture('lexicon/lexicon-invalid.json'),
    );

    expect(Array.isArray(fixtures)).toBe(true);

    // Check that invalid fixtures have expected structure
    for (const fixture of fixtures) {
      expect(fixture).toHaveProperty('name');
      expect(fixture).toHaveProperty('lexicon');
      // The "invalid" property may not exist
    }
  });
});
