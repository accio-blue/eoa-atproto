import { describe, expect, it } from 'vitest';
import { projectRecord, withinWindow } from './project.js';

/**
 * The projection a grant promises (`n6lg`). Everything here is about one property: what is not
 * listed does not survive, and `$type` always does.
 */
describe('projectRecord', () => {
  const note = {
    $type: 'ing.lexicon.space.note',
    startedAt: '2026-11-07T08:00:00.000Z',
    note: 'private: the athlete was tired',
    data: { pace: 4.2, hr: 168, secret: 'do not share' },
    tags: ['a', 'b'],
  };

  it('returns the record untouched when the grant promised no projection', () => {
    expect(projectRecord(note, undefined)).toEqual(note);
  });

  it('keeps the listed fields and $type, and drops the rest', () => {
    expect(projectRecord(note, ['/startedAt'])).toEqual({
      $type: note.$type,
      startedAt: note.startedAt,
    });
  });

  it('keeps a nested path without its siblings', () => {
    expect(projectRecord(note, ['/data/pace'])).toEqual({
      $type: note.$type,
      data: { pace: 4.2 },
    });
  });

  it('keeps a whole subtree when the path names it', () => {
    expect(projectRecord(note, ['/data'])).toEqual({
      $type: note.$type,
      data: note.data,
    });
  });

  it('keeps a list whole when the path names it', () => {
    expect(projectRecord(note, ['/tags'])).toEqual({
      $type: note.$type,
      tags: ['a', 'b'],
    });
  });

  it('drops a path the record does not have, rather than failing the read', () => {
    expect(projectRecord(note, ['/absent', '/note'])).toEqual({
      $type: note.$type,
      note: note.note,
    });
  });

  it('unescapes a JSON Pointer token, so a key with a slash is reachable', () => {
    const odd = { $type: 'app.example.odd', 'a/b': 1, 'c~d': 2, other: 3 };
    expect(projectRecord(odd, ['/a~1b', '/c~0d'])).toEqual({
      $type: 'app.example.odd',
      'a/b': 1,
      'c~d': 2,
    });
  });

  it('gives a record with no $type only the listed fields', () => {
    expect(projectRecord({ note: 'x', other: 'y' }, ['/note'])).toEqual({
      note: 'x',
    });
  });

  it('ignores a field that is not a pointer at all', () => {
    expect(projectRecord(note, ['startedAt'])).toEqual(note);
  });
});

describe('withinWindow', () => {
  const now = Date.parse('2026-11-07T10:00:00.000Z');
  const aged = (minutes: number) => ({
    $type: 'com.example.note',
    createdAt: new Date(now - minutes * 60_000).toISOString(),
  });

  it('passes a record inside the window', () => {
    expect(
      withinWindow(aged(10), { field: '/createdAt', maxAgeSeconds: 3600 }, now),
    ).toBe(true);
  });

  it('fails a record older than the window', () => {
    expect(
      withinWindow(aged(61), { field: '/createdAt', maxAgeSeconds: 3600 }, now),
    ).toBe(false);
  });

  it('fails when the field is absent, rather than passing it', () => {
    expect(
      withinWindow(
        { $type: 'com.example.note' },
        { field: '/createdAt', maxAgeSeconds: 3600 },
        now,
      ),
    ).toBe(false);
  });

  it('fails when the value is not a datetime', () => {
    expect(
      withinWindow(
        { $type: 'com.example.note', createdAt: 'yesterday' },
        { field: '/createdAt', maxAgeSeconds: 3600 },
        now,
      ),
    ).toBe(false);
  });

  it('reads a nested field', () => {
    expect(
      withinWindow(
        { $type: 'com.example.note', meta: { at: aged(5).createdAt } },
        { field: '/meta/at', maxAgeSeconds: 3600 },
        now,
      ),
    ).toBe(true);
  });
});
