// The shared fixtures helper lives in the repo-root `tests/utils` directory,
// which package tests may import by relative path (see tests/utils/README.md).
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadFixture,
  loadSyntaxFixture,
  loadTextFixture,
  parseSyntaxFixture,
} from '../../../tests/utils/fixtures.js';
import { Effect } from 'effect';
import { createXrpcClient } from './client.js';
import { createXrpcServer } from '@eoa/xrpc-server';

// NSIDs used by the in-process server. `net.users.bob.ping` is also present in
// the atproto interop syntax fixtures, so the tests can assert it is spec-valid.
const PING_NSID = 'net.users.bob.ping';
const ECHO_NSID = 'com.example.echo';
const FAILING_NSID = 'com.example.fail';

const REACHABILITY_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 25;

interface QueryLexiconFixture {
  readonly lexicon: number;
  readonly id: string;
}

const queryLexiconFixture = loadFixture<QueryLexiconFixture>(
  'lexicon/catalog/query.json',
);

// Ask the OS for an unused TCP port so parallel test files cannot collide.
const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

const isReachable = (url: string): Promise<boolean> =>
  fetch(url).then(
    () => true,
    () => false,
  );

const waitForReachable = async (url: string): Promise<void> => {
  const deadline = Date.now() + REACHABILITY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isReachable(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`XRPC server did not become reachable at ${url}`);
};

interface ActiveHandle {
  readonly address?: () => AddressInfo | string | null;
  readonly close?: (callback?: () => void) => void;
  readonly closeAllConnections?: () => void;
}

// `createXrpcServer().start` publishes no close handle and parks on
// `Effect.never`, so interrupting its fiber never completes. Closing the
// listening socket directly is the only teardown path that does not hang.
const closeListeningServer = (port: number): void => {
  const handles = (
    process as NodeJS.Process & {
      _getActiveHandles?: () => ReadonlyArray<ActiveHandle>;
    }
  )._getActiveHandles?.();

  for (const handle of handles ?? []) {
    const address = handle.address?.();
    if (
      address !== null &&
      typeof address === 'object' &&
      address.port === port
    ) {
      handle.closeAllConnections?.();
      handle.close?.();
      return;
    }
  }
};

let baseUrl = '';
let port = 0;

beforeAll(async () => {
  port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const server = createXrpcServer();
  server.method(PING_NSID, {}, (ctx) =>
    Effect.succeed({
      pong: true,
      params: ctx.params,
      headers: ctx.headers,
    }),
  );
  server.method(ECHO_NSID, {}, (ctx) => Effect.succeed(ctx.input));
  server.method(FAILING_NSID, {}, () =>
    Effect.fail(new Error('handler exploded')),
  );

  Effect.runFork(
    Effect.scoped(
      server
        .start({ port, hostname: '127.0.0.1' })
        .pipe(Effect.andThen(Effect.never)),
    ),
  );
  await waitForReachable(`${baseUrl}/xrpc/${PING_NSID}`);
});

afterAll(() => {
  if (port !== 0) {
    closeListeningServer(port);
  }
});

describe('XRPC client integration', () => {
  it('GET encodes query params and decodes a JSON response', async () => {
    const client = createXrpcClient({ service: baseUrl });

    const response = await Effect.runPromise(
      client.call(PING_NSID, { limit: 25, cursor: 'page-2', nested: true }),
    );

    expect(response.encoding).toContain('application/json');
    expect(response.headers['content-type']).toContain('application/json');
    // The server parses query params as strings.
    expect(response.body).toMatchObject({
      pong: true,
      params: { limit: '25', cursor: 'page-2', nested: 'true' },
    });
  });

  it('POST sends and receives a JSON body', async () => {
    const client = createXrpcClient({ service: baseUrl });

    const response = await Effect.runPromise(
      client.call(ECHO_NSID, undefined, queryLexiconFixture),
    );

    expect(response.body).toEqual(queryLexiconFixture);
  });

  it('resolves the service URL per NSID and forwards function headers', async () => {
    const client = createXrpcClient({
      service: (nsid) => {
        expect(nsid).toBe(PING_NSID);
        return baseUrl;
      },
      headers: {
        authorization: (nsid) => `Bearer ${nsid}`,
      },
    });

    const response = await Effect.runPromise(client.call(PING_NSID));

    expect(response.body).toMatchObject({
      headers: { authorization: `Bearer ${PING_NSID}` },
    });
  });

  it('maps an unknown method to a 404 XRPC error', async () => {
    const client = createXrpcClient({ service: baseUrl });

    const error = await Effect.runPromise(
      Effect.flip(client.call('com.example.doesNotExist')),
    );

    expect(error).toMatchObject({ _tag: 'NotFoundError', status: 404 });
  });

  it('maps a throwing handler to an error response', async () => {
    const client = createXrpcClient({ service: baseUrl });

    const error = await Effect.runPromise(
      Effect.flip(client.call(FAILING_NSID, undefined, { ping: true })),
    );

    expect(error).toMatchObject({
      _tag: 'InternalServerError',
      status: 500,
    });
  });

  it('exercises the shared interop fixtures', () => {
    const validNsids = loadSyntaxFixture('nsid_syntax_valid');
    const invalidNsids = loadSyntaxFixture('nsid_syntax_invalid.txt');

    expect(validNsids).toContain(PING_NSID);
    expect(invalidNsids).not.toContain(PING_NSID);
    // Blank lines and `#` / `//` comments are stripped by the parser.
    expect(validNsids).not.toContain('');
    expect(validNsids.every((line) => !line.trim().startsWith('#'))).toBe(true);
    expect(loadTextFixture('syntax/did_syntax_valid.txt')).toContain(
      'did:plc:',
    );
    expect(queryLexiconFixture.id).toBe('example.lexicon.query');
    // Both comment styles and blank lines are dropped.
    expect(parseSyntaxFixture('# hash\n// slashes\n\nvalue\n')).toEqual([
      'value',
    ]);
    // Path traversal outside the fixtures directory is rejected.
    expect(() => loadTextFixture('../package.json')).toThrow(
      /escapes the fixtures directory/,
    );
  });
});
