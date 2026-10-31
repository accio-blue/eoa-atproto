import { CallOptions, HeadersMap, QueryParams, XRPCError } from '@eoa/core';
import { Context, Effect } from 'effect';

// XRPC response types
export interface XrpcResponse<T = unknown> {
  readonly encoding: string;
  readonly body: T;
  readonly headers: HeadersMap;
}

// XRPC client service definition
export interface XrpcClient {
  readonly call: <Data>(
    nsid: string,
    params?: QueryParams,
    data?: Data,
    options?: CallOptions,
  ) => Effect.Effect<XrpcResponse, XRPCError | Error>;
}

// XRPC client tag for dependency injection
export const XrpcClient = Context.Service<XrpcClient>('XrpcClient');

// XRPC response types
export interface XrpcResponse<T = unknown> {
  readonly encoding: string;
  readonly body: T;
  readonly headers: HeadersMap;
}

// Fetch handler interface for custom HTTP implementations
export interface FetchHandler {
  (url: string, options: FetchOptions): Effect.Effect<FetchResponse, Error>;
}

// Fetch options for HTTP requests
export interface FetchOptions {
  readonly method: string;
  readonly headers: HeadersMap;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

// Fetch response interface
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeadersMap;
  readonly text: () => Effect.Effect<string, Error>;
  readonly json: () => Effect.Effect<unknown, Error>;
}

// Client configuration
export interface ClientConfig {
  readonly service?: string | ((nsid: string) => string);
  readonly headers?: Record<string, string | ((nsid: string) => string)>;
  readonly fetch?: FetchHandler;
}

// Response type enumeration (matching HTTP status codes)
export enum ResponseType {
  Success = 200,
  InvalidRequest = 400,
  AuthenticationRequired = 401,
  Forbidden = 403,
  NotFound = 404,
  RateLimitExceeded = 429,
  InternalServerError = 500,
  UpstreamFailure = 502,
  UpstreamTimeout = 504,
  NotEnoughResources = 507,
  MethodNotImplemented = 501,
}
