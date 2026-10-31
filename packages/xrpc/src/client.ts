import {
  CallOptions,
  HeadersMap,
  QueryParams,
  buildURL,
  createXRPCError,
  mergeHeaders,
} from '@eoa/core';
import {
  ClientConfig,
  FetchHandler,
  FetchResponse,
  XrpcClient,
  XrpcResponse,
} from './types.js';
import { Effect } from 'effect';
import { Lexicons } from '@eoa/lexicon';

// Errors returned by `createXRPCError` always carry a numeric `status`. Plain
// transport and parse errors (fetch failures, malformed JSON) do not. This
// tells the normalizer below whether an error already carries XRPC semantics.
const hasNumericStatus = (
  error: Error,
): error is Error & { readonly status: number } =>
  'status' in error && typeof error.status === 'number';

/** The `{ error, message }` shape atproto puts in a non-2xx JSON body. */
const isErrorBody = (
  value: unknown,
): value is { error?: string; message?: string } =>
  typeof value === 'object' && value !== null;

/**
 * Default HTTP transport. Wraps the global `fetch` into the `FetchHandler`
 * shape so `config.fetch` can swap in an authenticated transport (e.g. an
 * AT Protocol OAuth session's fetch handler) without changing call sites.
 */
const nativeFetchHandler: FetchHandler = (url, options) =>
  Effect.tryPromise({
    try: async (): Promise<FetchResponse> => {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        json: () =>
          Effect.tryPromise({
            try: () => response.json(),
            catch: (error) => new Error(`Failed to parse JSON: ${error}`),
          }),
        text: () =>
          Effect.tryPromise({
            try: () => response.text(),
            catch: (error) => new Error(`Failed to read text: ${error}`),
          }),
      };
    },
    catch: (error) => new Error(`Fetch failed: ${error}`),
  });

// Create an XRPC client with the given configuration
export const makeXrpcClient = (
  config: ClientConfig & { lexicons?: Lexicons },
): XrpcClient => {
  const client: XrpcClient = {
    call: <Data>(
      nsid: string,
      params?: QueryParams,
      data?: Data,
      options?: CallOptions,
    ) =>
      Effect.gen(function* () {
        // Build URL
        const baseUrl =
          typeof config.service === 'function'
            ? config.service(nsid)
            : config.service || 'https://api.bsky.app';

        const url = buildURL(baseUrl, `xrpc/${nsid}`, params);

        // Build headers
        let headers: HeadersMap = {};

        if (config.headers) {
          for (const [key, value] of Object.entries(config.headers)) {
            const headerValue =
              typeof value === 'function' ? value(nsid) : value;
            headers = mergeHeaders(headers, { [key]: headerValue });
          }
        }

        if (options?.headers) {
          headers = mergeHeaders(headers, options.headers);
        }

        // Determine HTTP method and body
        const method = data ? 'POST' : 'GET';
        let body: string | undefined;

        if (data) {
          headers = mergeHeaders(headers, {
            'Content-Type': options?.encoding || 'application/json',
          });
          body = typeof data === 'string' ? data : JSON.stringify(data);
        }

        // Make the request. `config.fetch` lets callers supply an
        // authenticated transport; the default wraps global `fetch`.
        const fetchHandler = config.fetch ?? nativeFetchHandler;
        const response = yield* fetchHandler(url, {
          method,
          headers,
          body,
          signal: undefined,
        });

        // Handle response. atproto answers a non-2xx with a JSON body
        // `{ error, message }` where `error` is the lexicon error name
        // (NotFound, AccountTakedown, ...). Read it so callers can branch on
        // the name; fall back to the status line when the body is not usable.
        if (!response.ok) {
          const contentType = response.headers['content-type'] ?? '';
          const parsed: unknown = yield* (
            contentType.includes('application/json')
              ? response.json()
              : response.text()
          ).pipe(Effect.orElseSucceed(() => undefined));

          const body = isErrorBody(parsed) ? parsed : undefined;
          const message =
            typeof body?.message === 'string'
              ? body.message
              : typeof parsed === 'string' && parsed.trim() !== ''
                ? parsed.trim()
                : response.statusText;

          return yield* Effect.fail(
            createXRPCError(
              response.status,
              message,
              response.headers,
              typeof body?.error === 'string' ? body.error : undefined,
            ),
          );
        }

        // Parse response body
        const contentType = response.headers['content-type'] ?? '';
        const responseBody: unknown = contentType.includes('application/json')
          ? yield* response.json()
          : yield* response.text();

        // TODO: Validate response if lexicons are available

        const xrpcResponse: XrpcResponse = {
          encoding: contentType,
          body: responseBody,
          headers: response.headers,
        };

        return xrpcResponse;
      }).pipe(
        Effect.catchIf(
          (error): error is Error => !hasNumericStatus(error),
          // A thrown fetch or a malformed body has no HTTP status: report 0 so
          // a caller can retry transport failures without also retrying 500s.
          (error) => Effect.fail(createXRPCError(0, error.message)),
        ),
        Effect.withSpan('xrpc.call', {
          attributes: {
            'xrpc.nsid': nsid,
            'http.request.method': data === undefined ? 'GET' : 'POST',
          },
        }),
      ),
  };

  return client;
};

// Create a default XRPC client
export const createXrpcClient = (
  config: ClientConfig & { lexicons?: Lexicons } = {},
): XrpcClient => makeXrpcClient(config);
