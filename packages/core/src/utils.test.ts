import * as Utils from './utils.js';
import { describe, it } from 'vitest';

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
