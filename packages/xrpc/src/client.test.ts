import * as XRPC from './client.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

describe('XRPC Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('makeXrpcClient', () => {
    it('should create a client with default config', () => {
      const client = XRPC.makeXrpcClient({});

      expect(client.call).toBeDefined();
      expect(typeof client.call).toBe('function');
    });

    it('should create a client with custom service URL', () => {
      const client = XRPC.makeXrpcClient({
        service: 'https://custom.api.com',
      });

      expect(client.call).toBeDefined();
    });

    it('should create a client with custom headers', () => {
      const client = XRPC.makeXrpcClient({
        headers: {
          Authorization: 'Bearer token123',
        },
      });

      expect(client.call).toBeDefined();
    });

    it('should create a client with lexicons', () => {
      const lexicons = {} as any;
      const client = XRPC.makeXrpcClient({ lexicons });

      expect(client.call).toBeDefined();
    });
  });

  describe('createXrpcClient', () => {
    it('should be alias for makeXrpcClient', () => {
      const client1 = XRPC.makeXrpcClient({});
      const client2 = XRPC.createXrpcClient({});

      expect(typeof client1.call).toBe('function');
      expect(typeof client2.call).toBe('function');
    });
  });

  describe('client.call', () => {
    it('should be a function', () => {
      const client = XRPC.makeXrpcClient({});
      expect(typeof client.call).toBe('function');
    });

    it('should accept nsid parameter', () => {
      const client = XRPC.makeXrpcClient({});
      expect(() => client.call('com.example.test')).not.toThrow();
    });

    it('should accept optional params parameter', () => {
      const client = XRPC.makeXrpcClient({});
      expect(() => client.call('com.example.test', {})).not.toThrow();
    });

    it('should accept optional data parameter', () => {
      const client = XRPC.makeXrpcClient({});
      expect(() => client.call('com.example.test', {}, {})).not.toThrow();
    });

    it('should accept optional options parameter', () => {
      const client = XRPC.makeXrpcClient({});
      expect(() => client.call('com.example.test', {}, {}, {})).not.toThrow();
    });

    it('should return an Effect', () => {
      const client = XRPC.makeXrpcClient({});
      const result = client.call('com.example.test');

      expect(Effect.isEffect(result)).toBe(true);
    });
  });

  describe('ClientConfig', () => {
    it('should accept string service URL', () => {
      expect(() =>
        XRPC.makeXrpcClient({ service: 'https://api.example.com' }),
      ).not.toThrow();
    });

    it('should accept function service resolver', () => {
      const serviceResolver = (_nsid: string) => 'https://api.example.com';
      expect(() =>
        XRPC.makeXrpcClient({ service: serviceResolver }),
      ).not.toThrow();
    });

    it('should accept headers object', () => {
      expect(() =>
        XRPC.makeXrpcClient({
          headers: { Authorization: 'Bearer token' },
        }),
      ).not.toThrow();
    });

    it('should accept headers with function values', () => {
      expect(() =>
        XRPC.makeXrpcClient({
          headers: { Authorization: (nsid: string) => `Bearer ${nsid}` },
        }),
      ).not.toThrow();
    });

    it('should accept empty config', () => {
      expect(() => XRPC.makeXrpcClient({})).not.toThrow();
    });
  });

  describe('custom fetch transport', () => {
    it('routes calls through config.fetch instead of global fetch', async () => {
      const calls: Array<{
        method: string;
        url: string;
        body: string | undefined;
      }> = [];
      const client = XRPC.makeXrpcClient({
        service: 'https://example.test',
        fetch: (url, options) => {
          calls.push({ method: options.method, url, body: options.body });
          return Effect.succeed({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            json: () => Effect.succeed({ hello: 'world' }),
            text: () => Effect.succeed(''),
          });
        },
      });

      const response = await Effect.runPromise(
        client.call('com.example.getThing', { a: 'b' }),
      );

      expect(response.body).toEqual({ hello: 'world' });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('GET');
      expect(calls[0]?.url).toContain('/xrpc/com.example.getThing');
      expect(calls[0]?.url).toContain('a=b');
    });

    it('POSTs when data is provided', async () => {
      const calls: Array<{ method: string; body: string | undefined }> = [];
      const client = XRPC.makeXrpcClient({
        service: 'https://example.test',
        fetch: (_url, options) => {
          calls.push({ method: options.method, body: options.body });
          return Effect.succeed({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            json: () => Effect.succeed({}),
            text: () => Effect.succeed(''),
          });
        },
      });

      await Effect.runPromise(
        client.call('com.example.createThing', undefined, { x: 1 }),
      );

      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.body).toBe(JSON.stringify({ x: 1 }));
    });
  });

  describe('error responses', () => {
    const failing = (
      status: number,
      statusText: string,
      body: string,
      headers: Record<string, string> = {
        'content-type': 'application/json',
      },
    ) => {
      const client = XRPC.makeXrpcClient({
        service: 'https://example.test',
        fetch: () =>
          Effect.succeed({
            ok: false,
            status,
            statusText,
            headers,
            json: () => Effect.succeed(JSON.parse(body)),
            text: () => Effect.succeed(body),
          }),
      });
      return Effect.runPromise(
        Effect.flip(client.call('com.example.getThing')),
      );
    };

    it('keeps the lexicon error name and message from a 400 body', async () => {
      const error = await failing(
        400,
        'Bad Request',
        JSON.stringify({ error: 'NotFound', message: 'Post not found' }),
      );

      expect(error).toMatchObject({
        status: 400,
        error: 'NotFound',
        message: 'Post not found',
      });
    });

    it('keeps an AccountTakedown name from a 400 body', async () => {
      const error = await failing(
        400,
        'Bad Request',
        JSON.stringify({
          error: 'AccountTakedown',
          message: 'Account has been suspended',
        }),
      );

      expect(error).toMatchObject({ status: 400, error: 'AccountTakedown' });
    });

    it('reports a 414 long-cursor response and its text body', async () => {
      const error = await failing(414, 'URI Too Long', 'URI Too Long', {
        'content-type': 'text/plain',
      });

      expect(error).toMatchObject({ status: 414, message: 'URI Too Long' });
    });

    it('marks a thrown fetch as status 0', async () => {
      const client = XRPC.makeXrpcClient({
        service: 'https://example.test',
        fetch: () => Effect.fail(new Error('fetch failed')),
      });

      const error = await Effect.runPromise(
        Effect.flip(client.call('com.example.getThing')),
      );

      expect(error).toMatchObject({ status: 0, message: 'fetch failed' });
    });

    it('leaves an HTTP 500 as status 500', async () => {
      const error = await failing(
        500,
        'Internal Server Error',
        JSON.stringify({ error: 'InternalServerError', message: 'boom' }),
      );

      expect(error).toMatchObject({
        _tag: 'InternalServerError',
        status: 500,
        message: 'boom',
      });
    });

    it('carries the response headers on a 429', async () => {
      const error = await failing(
        429,
        'Too Many Requests',
        JSON.stringify({ error: 'RateLimitExceeded', message: 'slow down' }),
        { 'content-type': 'application/json', 'retry-after': '30' },
      );

      expect(error).toMatchObject({
        status: 429,
        headers: { 'retry-after': '30' },
      });
    });
  });
});
