import { Effect, Option, Schema } from 'effect';

/**
 * The client's I/O edges, kept as narrow ports so a test can drive a stub
 * authorization server without a network.
 */

/** One request, in the shape this client's fetch port takes it. */
export interface FetchRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** The fetch this client uses. */
export type FetchLike = (request: FetchRequest) => Promise<Response>;

/** Reported when a request could not be made at all (as opposed to refused). */
export class HttpError extends Schema.TaggedError<HttpError>()('HttpError', {
  message: Schema.String,
}) {}

/** `application/x-www-form-urlencoded`, omitting the fields that are absent. */
export const formBody = (
  fields: Readonly<Record<string, string | undefined>>,
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params.toString();
};

/** One request. The caller owns the response body. */
export const send = (params: {
  readonly fetch: FetchLike;
  readonly url: string;
  readonly method: string;
  readonly headers?: HeadersInit;
  /** A JSON body is text; a blob upload is bytes. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
}): Effect.Effect<Response, HttpError> => {
  const init: RequestInit = { method: params.method };
  if (params.headers !== undefined) {
    init.headers = params.headers;
  }
  if (params.body !== undefined) {
    init.body = params.body;
  }

  return Effect.tryPromise({
    try: () => params.fetch({ url: params.url, init }),
    catch: (cause) =>
      new HttpError({
        message: `request to ${params.url} failed: ${String(cause)}`,
      }),
  });
};

/** The body as text, with a failure rather than a rejection we cannot see. */
export const responseText = (
  response: Response,
): Effect.Effect<string, HttpError> =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new HttpError({
        message: `could not read the response: ${String(cause)}`,
      }),
  });

/** A JSON document's `error` member, when it has one. */
export const errorCodeOf = (body: string): Option.Option<string> => {
  const decoded = Schema.decodeOption(
    Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
  )(body);
  return Option.map(decoded, (value) => value.error);
};

/** Decode a JSON body against its schema, or `None` for anything else. */
export const jsonDecoded = <
  S extends Schema.ConstraintDecoder<unknown>,
>(params: {
  readonly schema: S;
  readonly text: string;
}): Option.Option<S['Type']> =>
  Schema.decodeOption(Schema.fromJsonString(params.schema))(params.text);
