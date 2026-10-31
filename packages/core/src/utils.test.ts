import * as Utils from './utils.js';
import { describe, it } from 'vitest';
import { Effect } from 'effect';

describe('buildURL', () => {
  it('should build a URL without params', () => {
    const url = Utils.buildURL('https://api.example.com', '/test');
    expect(url).toBe('https://api.example.com/test');
  });

  it('should build a URL with params', () => {
    const url = Utils.buildURL('https://api.example.com', '/test', {
      foo: 'bar',
      num: 42,
    });
    expect(url).toContain('foo=bar');
    expect(url).toContain('num=42');
  });

  it('should filter undefined and null params', () => {
    const url = Utils.buildURL('https://api.example.com', '/test', {
      foo: 'bar',
      undef: undefined,
      nul: null,
    });
    expect(url).toContain('foo=bar');
    expect(url).not.toContain('undef');
    expect(url).not.toContain('nul');
  });
});

describe('mergeHeaders', () => {
  it('should merge multiple header objects', () => {
    const headers = Utils.mergeHeaders(
      { 'Content-Type': 'application/json' },
      { Authorization: 'Bearer token' },
    );
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
    });
  });

  it('should skip undefined headers', () => {
    const headers = Utils.mergeHeaders(
      { 'Content-Type': 'application/json' },
      undefined,
    );
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('should return empty object when no headers', () => {
    const headers = Utils.mergeHeaders(undefined, undefined);
    expect(headers).toEqual({});
  });

  it('should override headers with later values', () => {
    const headers = Utils.mergeHeaders(
      { 'Content-Type': 'text/plain' },
      { 'Content-Type': 'application/json' },
    );
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('generateTID', () => {
  it('should generate a TID string', () => {
    const tid = Utils.generateTID();
    expect(typeof tid).toBe('string');
    expect(tid.length).toBeGreaterThan(0);
  });

  it('should generate unique TIDs', () => {
    const tid1 = Utils.generateTID();
    const tid2 = Utils.generateTID();
    expect(tid1).not.toBe(tid2);
  });
});

describe('sleep', () => {
  it('should sleep for the specified duration', async () => {
    const program = Utils.sleep(10).pipe(Effect.map(() => 'slept'));
    const result = await Effect.runPromise(program);
    expect(result).toBe('slept');
  });
});

describe('withTimeout', () => {
  it('should succeed before timeout', async () => {
    const program = Utils.withTimeout(Effect.succeed('done'), 100);
    const result = await Effect.runPromise(program);
    expect(result).toBe('done');
  });

  it('should timeout if effect takes too long', async () => {
    const program = Utils.withTimeout(Utils.sleep(100), 10).pipe(Effect.flip);
    const error = await Effect.runPromise(program);
    expect(error._tag).toBe('TimeoutError');
  });
});
