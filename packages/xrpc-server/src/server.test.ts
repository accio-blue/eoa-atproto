import { Effect, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, createXrpcServer } from './server.js';
import { WebSocket } from 'ws';
import type { XrpcServer } from './types.js';
import { createServer as createNetServer } from 'node:net';

interface ActiveHandle {
  readonly address?: () => string | { readonly port: number } | null;
  readonly close?: (callback?: () => void) => void;
}

const activeHandles = (): readonly ActiveHandle[] => {
  const processWithHandles = process as NodeJS.Process & {
    readonly _getActiveHandles?: () => readonly ActiveHandle[];
  };
  return processWithHandles._getActiveHandles?.() ?? [];
};

const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port =
        address !== null && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

// The server's `start` effect never resolves and its interruption finalizer is
// Effect.never, so it cannot be interrupted. Close the listening socket
// directly by matching the port in the active handles instead.
const closeListeningServer = (port: number): void => {
  for (const handle of activeHandles()) {
    const address = handle.address?.();
    if (
      address !== null &&
      typeof address === 'object' &&
      'port' in address &&
      address.port === port
    ) {
      handle.close?.();
      return;
    }
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitForServer = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The server refuses connections until it is listening.
    }
    await delay(20);
  }
  throw new Error(`Server did not become ready at ${url}`);
};

describe('server construction', () => {
  it('exposes method, stream and start', () => {
    const server = createXrpcServer();

    expect(typeof server.method).toBe('function');
    expect(typeof server.stream).toBe('function');
    expect(typeof server.start).toBe('function');
  });

  it('createServer is an alias for createXrpcServer', () => {
    const server = createServer();

    expect(typeof server.method).toBe('function');
    expect(typeof server.start).toBe('function');
  });

  it('start returns an Effect', () => {
    const server = createXrpcServer();

    expect(Effect.isEffect(server.start())).toBe(true);
  });
});

describe('xrpc server HTTP routing', () => {
  let baseUrl = '';
  let serverPort = 0;
  let server: XrpcServer | undefined;

  const activeServer = (): XrpcServer => {
    if (!server) {
      throw new Error('XRPC server was not started');
    }
    return server;
  };

  beforeAll(async () => {
    serverPort = await getFreePort();
    baseUrl = `http://127.0.0.1:${serverPort}`;

    const xrpcServer = createXrpcServer();
    xrpcServer.method('com.example.ping', {}, () =>
      Effect.succeed({ pong: true }),
    );
    xrpcServer.method('com.example.echo', {}, (ctx) =>
      Effect.succeed({ received: ctx.input, params: ctx.params }),
    );
    xrpcServer.method('com.example.fail', {}, () =>
      Effect.fail(new Error('boom')),
    );
    xrpcServer.stream('com.example.stream', {}, () => Stream.never);
    server = xrpcServer;

    // The listener lives as long as the scope that started it, so it is run
    // detached and closed by leaving that scope in afterAll.
    Effect.runFork(
      Effect.scoped(
        xrpcServer
          .start({ port: serverPort, hostname: '127.0.0.1' })
          .pipe(Effect.andThen(Effect.never)),
      ),
    );

    await waitForServer(`${baseUrl}/xrpc/com.example.ping`);
  }, 15000);

  afterAll(() => {
    closeListeningServer(serverPort);
  });

  it('routes GET requests and extracts query parameters', async () => {
    const response = await fetch(
      `${baseUrl}/xrpc/com.example.echo?did=alice&limit=10`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = (await response.json()) as {
      params: Record<string, string>;
    };
    expect(body.params).toEqual({ did: 'alice', limit: '10' });
  });

  it('routes POST requests and parses the JSON body', async () => {
    const response = await fetch(`${baseUrl}/xrpc/com.example.echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      received: { hello: string };
    };
    expect(body.received).toEqual({ hello: 'world' });
  });

  it('rejects invalid JSON bodies with 400', async () => {
    const response = await fetch(`${baseUrl}/xrpc/com.example.echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON' });
  });

  it('returns 404 for an unknown method', async () => {
    const response = await fetch(`${baseUrl}/xrpc/com.example.missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Method not found',
    });
  });

  it('returns 404 for a non-xrpc path', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('turns handler failures into an error response', async () => {
    const response = await fetch(`${baseUrl}/xrpc/com.example.fail`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'boom',
      code: 'Error',
    });
  });

  it('lets a later registration replace an earlier handler', async () => {
    activeServer().method('com.example.override', {}, () =>
      Effect.succeed({ version: 1 }),
    );
    activeServer().method('com.example.override', {}, () =>
      Effect.succeed({ version: 2 }),
    );

    const response = await fetch(`${baseUrl}/xrpc/com.example.override`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version: 2 });
  });

  it('registers stream handlers that are not routed over plain HTTP', async () => {
    expect(() =>
      activeServer().stream('com.example.chat', {}, () => Stream.never),
    ).not.toThrow();

    const response = await fetch(`${baseUrl}/xrpc/com.example.chat`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Method not found',
    });
  });

  it('streams a plain route outside /xrpc, chunk by chunk, before it ends', async () => {
    const encoder = new TextEncoder();
    activeServer().route('/plain/lines', (url) =>
      Effect.succeed(
        new Response(
          Stream.make(`first ${url.searchParams.get('n')}\n`).pipe(
            Stream.concat(Stream.never),
            Stream.map((line) => encoder.encode(line)),
            Stream.toReadableStream(),
          ),
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
      ),
    );

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/plain/lines?n=1`, {
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    // The stream never ends, so a buffered body would never arrive: the first chunk is the proof.
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe('first 1\n');
    controller.abort();
  });

  it('serves a registered stream over a socket, and closes when it ends', async () => {
    const encoder = new TextEncoder();
    activeServer().stream('com.example.ticks', {}, () =>
      Stream.make(encoder.encode('one'), encoder.encode('two')),
    );

    const client = new WebSocket(
      `ws://127.0.0.1:${serverPort}/xrpc/com.example.ticks`,
    );
    const frames: string[] = [];
    client.on('message', (data) => {
      frames.push(String(data));
    });
    // A stream that ends ends the socket, which is the only way a client learns
    // there is nothing more coming.
    await new Promise((resolve) => {
      client.on('close', resolve);
    });

    expect(frames).toEqual(['one', 'two']);
  });
});
