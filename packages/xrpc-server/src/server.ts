import { Effect, Fiber, Stream } from 'effect';
import {
  HandlerContext,
  MethodConfig,
  MethodHandler,
  type Middleware,
  type ServerCall,
  type ServerConfig,
  StreamHandler,
  XrpcServer,
  createErrorResponse,
  createJsonResponse,
} from './types.js';
import {
  type IncomingMessage,
  type Server,
  createServer as createHttpServer,
} from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { Lexicons } from '@eoa/lexicon';

/** A body we read as JSON: the type says so, or says nothing. */
const wantsJson = (contentType: string) =>
  contentType === '' || contentType.includes('application/json');

/** The request body, as it arrived. */
const readBody = (req: IncomingMessage) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });

/** The body read as JSON, or the news that it is not. */
const jsonOf = (body: Uint8Array) => {
  try {
    return {
      ok: true as const,
      value: JSON.parse(new TextDecoder().decode(body)),
    };
  } catch {
    return { ok: false as const };
  }
};

/** A listener that is up: the port it took, and the servers to close. */
interface Bound {
  readonly port: number;
  readonly server: Server;
  readonly sockets: WebSocketServer;
}

/**
 * The request's headers, as the context promises them. Node joins a repeated
 * request header into one string, so this is the whole of what a handler can
 * be given — and saying so is better than a cast that claims it already.
 */
const headersOf = (request: IncomingMessage) => {
  const held: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      held[key] = value;
    }
  }
  return held;
};

/**
 * One socket, one registered stream: the handler's bytes go out, and the socket
 * ends when the stream does. Framing is the handler's — this carries a stream.
 */
const streamSocketHandler = (params: {
  readonly handler: StreamHandler;
  readonly nsid: string;
  readonly request: IncomingMessage;
  readonly socket: WebSocket;
  readonly url: URL;
}) => {
  const asked: Record<string, string> = {};
  for (const [key, value] of params.url.searchParams) {
    asked[key] = value;
  }
  const ctx: HandlerContext = {
    params: asked,
    nsid: params.nsid,
    method: params.request.method ?? 'GET',
    url: `${params.url.origin}${params.url.pathname}`,
    headers: headersOf(params.request),
  };

  return Stream.runForEach(params.handler(ctx), (frame) =>
    Effect.sync(() => {
      params.socket.send(frame);
    }),
  ).pipe(
    // A stream that failed ends the socket saying so, rather than leaving the
    // client to wait for a frame that is not coming.
    Effect.catch((error) =>
      Effect.sync(() => {
        params.socket.close(1011, String(error));
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        params.socket.close();
      }),
    ),
  );
};

/** The configured middleware, wrapped around a method's handler. First is outermost. */
const applyMiddleware = (
  middleware: readonly Middleware[],
  handler: MethodHandler,
) => middleware.reduceRight((inner, one) => one(inner), handler);

/**
 * One call, answered.
 *
 * Both adapters come here, and that is the point: a runtime that hands you a
 * `Request` needs no second copy of the rules — the one that a body is **bytes**
 * and only a JSON body is parsed, the one that a handler may answer with a
 * `Response` of its own, and the one that a failure is answered as an error
 * rather than a stack. `start` writes the answer to a socket; `handle` returns
 * it.
 */
const serveCall = async (params: {
  readonly methods: ReadonlyMap<
    string,
    { readonly config: MethodConfig; readonly handler: MethodHandler }
  >;
  readonly routes: ReadonlyMap<
    string,
    (url: URL, call: ServerCall) => Effect.Effect<Response>
  >;
  readonly config: ServerConfig;
  readonly call: ServerCall;
}): Promise<Response> => {
  const url = new URL(params.call.url);
  const route = params.routes.get(url.pathname);
  if (route !== undefined && params.call.method === 'GET') {
    return Effect.runPromise(route(url, params.call));
  }
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (pathParts[0] !== 'xrpc') {
    return createJsonResponse({ error: 'Not found' }, 404);
  }
  const nsid = pathParts.slice(1).join('.');
  const methodDef = params.methods.get(nsid);
  if (methodDef === undefined) {
    return createJsonResponse({ error: 'Method not found' }, 404);
  }

  const asked: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    asked[key] = value;
  }

  const contentType = params.call.headers['content-type'] ?? '';
  const parsed =
    params.call.body !== undefined && wantsJson(contentType)
      ? jsonOf(params.call.body)
      : { ok: true as const, value: undefined };
  if (!parsed.ok) {
    return createJsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const ctx: HandlerContext = {
    params: asked,
    nsid,
    method: params.call.method,
    url: `${url.origin}${url.pathname}`,
    input: parsed.value,
    body: params.call.body,
    headers: params.call.headers,
  };

  try {
    const result = await Effect.runPromise(
      applyMiddleware(params.config.middleware ?? [], methodDef.handler)(ctx),
    );
    // A handler may answer with a `Response` of its own — bytes, and a content
    // type of its choosing — and then we are only a courier.
    return result instanceof Response ? result : createJsonResponse(result);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return params.config.errorHandler === undefined
      ? createErrorResponse(failure)
      : await Effect.runPromise(params.config.errorHandler(failure));
  }
};

// Create an XRPC server
export const createXrpcServer = (_lexicons?: Lexicons): XrpcServer => {
  const methods = new Map<
    string,
    { config: MethodConfig; handler: MethodHandler }
  >();
  const streams = new Map<
    string,
    { config: MethodConfig; handler: StreamHandler }
  >();
  const routes = new Map<
    string,
    (url: URL, call: ServerCall) => Effect.Effect<Response>
  >();

  const server: XrpcServer = {
    method: (nsid, config, handler) => {
      methods.set(nsid, { config, handler: handler as MethodHandler });
    },

    stream: (nsid, config, handler) => {
      streams.set(nsid, { config, handler });
    },

    streamOf: (nsid) => streams.get(nsid)?.handler,

    route: (path, handler) => {
      routes.set(path, handler);
    },

    start: (config = {}) => {
      const port = config.port ?? 3000;
      const hostname = config.hostname || 'localhost';

      const opened = Effect.gen(function* () {
        // Create HTTP server
        const httpServer = createHttpServer(async (req: any, res: any) => {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const response = await serveCall({
            methods,
            routes,
            config,
            call: {
              url: url.toString(),
              method: req.method ?? 'GET',
              headers: headersOf(req),
              body: req.method === 'POST' ? await readBody(req) : undefined,
            },
          });
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body === null) {
            res.end();
            return;
          }
          // Written as it comes, not buffered: a streamed body (Jetstream) never ends. A client that
          // leaves cancels the source, so the stream behind it stops rather than running on.
          // Headers go now: a quiet stream would otherwise hold them until its first frame, and a
          // client waits on headers before it reads anything.
          res.flushHeaders();
          const reader = response.body.getReader();
          res.on('close', () => {
            void reader.cancel();
          });
          for (;;) {
            const chunk = await reader
              .read()
              .catch(() => ({ done: true as const, value: undefined }));
            if (chunk.done) {
              break;
            }
            res.write(chunk.value);
          }
          res.end();
        });

        // A socket is where a stream lives, so the transport owns the upgrade:
        // the path names the stream, the registry says who serves it, and the
        // bytes are the handler's to frame.
        const sockets = new WebSocketServer({ noServer: true });
        sockets.on('connection', (socket, request) => {
          const url = new URL(
            request.url ?? '/',
            `http://${request.headers.host ?? 'localhost'}`,
          );
          const pathParts = url.pathname.split('/').filter(Boolean);
          const nsid =
            pathParts[0] === 'xrpc' ? pathParts.slice(1).join('.') : '';
          const registered = streams.get(nsid);
          if (registered === undefined) {
            socket.close(4004, 'no such stream');
            return;
          }

          const session = Effect.runFork(
            streamSocketHandler({
              handler: registered.handler,
              nsid,
              request,
              socket,
              url,
            }),
          );
          // A client that goes away ends its own subscription: without this the
          // fiber waits on a stream that will never end, and a stream is a
          // fan-out — one queue per connection that ever happened.
          const end = () => {
            Effect.runFork(Fiber.interrupt(session));
          };
          socket.on('close', end);
          socket.on('error', end);
        });

        httpServer.on('upgrade', (request, socket, head) => {
          sockets.handleUpgrade(request, socket, head, (opened) => {
            sockets.emit('connection', opened, request);
          });
        });

        // Bind, and answer with the port that was actually taken — a caller
        // that asked for 0 needs to know which one it got.
        return yield* Effect.callback<Bound, Error>((resume) => {
          httpServer.listen(port, hostname, () => {
            const address = httpServer.address();
            resume(
              Effect.succeed({
                port:
                  typeof address === 'object' && address !== null
                    ? address.port
                    : port,
                server: httpServer,
                sockets,
              }),
            );
          });

          httpServer.on('error', (error: Error) => resume(Effect.fail(error)));

          return Effect.void;
        });
      });

      // The listener lives as long as the scope that started it, and the caller
      // gets the port back rather than having to guess one.
      return Effect.acquireRelease(opened, (held) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              held.sockets.close();
              held.server.close(() => resolve());
            }),
        ),
      ).pipe(Effect.map((held) => held.port));
    },

    // No middleware and no error handler of its own: those belong to whoever is
    // serving, and a runtime that hands us a `Request` serves its own.
    handle: async (request) => {
      const body =
        request.method === 'POST'
          ? new Uint8Array(await request.arrayBuffer())
          : undefined;
      return serveCall({
        methods,
        routes,
        config: {},
        call: {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body,
        },
      });
    },
  };

  return server;
};

// Default server creation
export const createServer = (lexicons?: Lexicons): XrpcServer => {
  return createXrpcServer(lexicons);
};
