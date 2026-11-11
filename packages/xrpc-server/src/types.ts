import { Effect, Schema, type Scope, Stream } from 'effect';
import { HeadersMap } from '@eoa/core';

// Handler context for XRPC method handlers
export interface HandlerContext<A = unknown> {
  readonly params: Readonly<Record<string, string>>;
  /** The method the transport resolved, e.g. `com.atproto.repo.getRecord`. */
  readonly nsid: string;
  /** The request's method and URL, which is what a DPoP proof is bound to. */
  readonly method?: string;
  readonly url?: string;
  readonly input?: A;
  /**
   * The request body, as it arrived. `input` is the same bytes read as JSON,
   * and only when the type says they are JSON — so a handler that takes a file
   * finds its file here.
   */
  readonly body?: Uint8Array | undefined;
  readonly auth?: AuthInfo;
  readonly headers: HeadersMap;
}

// Authentication information
export interface AuthInfo {
  readonly credentials: {
    readonly type: 'service' | 'user';
    readonly did: string;
    readonly audience?: string;
  };
  readonly artifacts?: Readonly<Record<string, Schema.Json>>;
}

/**
 * A call as it arrived, whatever delivered it.
 *
 * A plain route gets this too: a credential arrives in a header, and an endpoint that serves a
 * permissioned stream (Jetstream's space mode) has to see the same ones a socket handler does.
 */
export interface ServerCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The body as it arrived — `undefined` when there was none. */
  readonly body: Uint8Array | undefined;
}

/**
 * A handler answers with JSON — or with a `Response` of its own, which is how a
 * method that returns bytes (a blob) answers at all.
 */
export type MethodHandler<I = unknown, O = Schema.Json> = (
  ctx: HandlerContext<I>,
) => Effect.Effect<O | Response, Error>;

/**
 * A stream handler answers with the **bytes** to put on the socket, and the
 * framing is its business: the transport carries a stream, and knows nothing
 * about CBOR, or a cursor, or what a `#commit` is. The socket ends when the
 * stream does.
 */
export type StreamHandler = (
  ctx: HandlerContext,
) => Stream.Stream<Uint8Array, Error>;

// Method configuration
export interface MethodConfig<A = unknown> {
  readonly auth?: AuthVerifier<A>;
  readonly rateLimit?: RateLimitConfig;
  readonly validateInput?: boolean;
  readonly validateOutput?: boolean;
}

// Authentication verifier
export type AuthVerifier<A = unknown> = (ctx: {
  req: Request;
  params: Readonly<Record<string, string>>;
}) => Effect.Effect<A, Error>;

// Rate limiting configuration
export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly keyGenerator?: (ctx: HandlerContext) => string;
}

// Server configuration
export interface ServerConfig {
  readonly port?: number;
  readonly hostname?: string;
  readonly validateResponse?: boolean;
  readonly errorHandler?: (error: Error) => Effect.Effect<Response, never>;
  readonly middleware?: readonly Middleware[];
}

// Middleware function type
/**
 * Middleware wraps a handler without changing what it answers: it sees the
 * context, and the handler's success and failure, and passes both through.
 */
export type Middleware = <A, E>(
  handler: (ctx: HandlerContext) => Effect.Effect<A, E>,
) => (ctx: HandlerContext) => Effect.Effect<A, E>;

// Server interface
export interface XrpcServer {
  readonly method: <A, I, O>(
    nsid: string,
    config: MethodConfig<A>,
    handler: MethodHandler<I, O>,
  ) => void;

  readonly stream: (
    nsid: string,
    config: MethodConfig,
    handler: StreamHandler,
  ) => void;

  /**
   * The handler a stream path names, or nothing.
   *
   * For a host that was handed its socket a different way: a listener owns the upgrade, and a
   * Worker does not get one — its socket arrives as a `WebSocketPair` on the response. The
   * registry is the same one `start` serves, so a host writes only what its runtime does
   * differently.
   */
  readonly streamOf: (nsid: string) => StreamHandler | undefined;

  /**
   * A plain `GET` path outside `/xrpc`, answered with a `Response` of the handler's own. For what the
   * ecosystem serves beside the protocol (Jetstream's NDJSON); a `ReadableStream` body streams.
   *
   * The handler gets the call as well as the URL. A handler that names only the URL stays assignable,
   * so this is additive: existing routes did not have to change to start reading headers.
   */
  readonly route: (
    path: string,
    handler: (url: URL, call: ServerCall) => Effect.Effect<Response>,
  ) => void;

  /**
   * Bind, and answer with the port that was taken. The listener lives as long
   * as the scope that started it, so a caller can close it by leaving the
   * scope rather than by guessing at the socket.
   */
  readonly start: (
    config?: ServerConfig,
  ) => Effect.Effect<number, Error, Scope.Scope>;

  /**
   * Answer one `Request` with a `Response`: the same dispatch `start` serves over
   * a socket, without a socket.
   *
   * A runtime that *is* a fetch handler — a Cloudflare Worker, Deno, Bun —
   * serves this server by calling this. Streams are not here: an upgrade is a
   * socket's business, and a runtime that has one gives it its own.
   */
  readonly handle: (request: Request) => Promise<Response>;
}

// Response utilities
/**
 * A JSON answer, with its length written down.
 *
 * The length is known here, and saying it is what lets the transport write the
 * answer in one `end()` instead of streaming a string through a reader. It also
 * closes a silent hole: `JSON.stringify(undefined)` is `undefined`, and a
 * `Response` built from that has **no body** — an empty 200 a client cannot
 * tell from a bug. `null` is a JSON value, so a handler that answered nothing
 * answers `null` and the caller's decoder says so.
 */
const jsonAnswer = (body: Schema.Json) => {
  const text = JSON.stringify(body) ?? 'null';
  return {
    text,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(text).length),
    },
  };
};

export const createJsonResponse = (
  body: Schema.Json,
  status = 200,
): Response => {
  const answer = jsonAnswer(body);
  return new Response(answer.text, {
    status,
    headers: answer.headers,
  });
};

/**
 * An XRPC error: the name a client switches on, and the status it carries.
 * Atproto answers a failure with `{ error }` and a 4xx — not a 500 with a
 * stack — so an error that knows its own shape is answered as one.
 */
export class XrpcError extends Schema.TaggedError<XrpcError>()('XrpcError', {
  error: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}

export const createErrorResponse = (error: Error, status = 500): Response => {
  if (error instanceof XrpcError) {
    const answer = jsonAnswer({ error: error.error, message: error.message });
    return new Response(answer.text, {
      status: error.status,
      headers: answer.headers,
    });
  }
  const answer = jsonAnswer({
    error: error.message,
    code: error.name,
  });
  return new Response(answer.text, {
    status,
    headers: answer.headers,
  });
};
