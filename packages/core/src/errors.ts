import { Data } from 'effect';

// Base error classes for AT Protocol operations
export class XRPCError extends Data.TaggedError('XRPCError')<{
  readonly status: number;
  readonly message: string;
  readonly headers: Record<string, string> | undefined;
  // The lexicon error name from the response body (`{ error, message }`), e.g.
  // "NotFound" or "AccountTakedown". Kept as the raw server string because
  // lexicon error names are open-ended; callers branch on the ones they know.
  readonly error: string | undefined;
}> {}

export class XRPCInvalidResponseError extends Data.TaggedError(
  'XRPCInvalidResponseError',
)<{
  readonly status: number;
  readonly message: string;
  readonly validationErrors: ReadonlyArray<string>;
}> {}

// Specific error types matching HTTP status codes
export class AuthenticationRequiredError extends Data.TaggedError(
  'AuthenticationRequiredError',
)<{
  readonly status: 401;
  readonly message: string;
}> {}

export class ForbiddenError extends Data.TaggedError('ForbiddenError')<{
  readonly status: 403;
  readonly message: string;
}> {}

export class NotFoundError extends Data.TaggedError('NotFoundError')<{
  readonly status: 404;
  readonly message: string;
}> {}

export class RateLimitExceededError extends Data.TaggedError(
  'RateLimitExceededError',
)<{
  readonly status: 429;
  readonly message: string;
  readonly headers: Record<string, string> | undefined;
}> {}

export class InternalServerError extends Data.TaggedError(
  'InternalServerError',
)<{
  readonly status: 500;
  readonly message: string;
}> {}

export class UpstreamFailureError extends Data.TaggedError(
  'UpstreamFailureError',
)<{
  readonly status: 502;
  readonly message: string;
}> {}

// Network and timeout errors
export class NetworkError extends Data.TaggedError('NetworkError')<{
  readonly cause: Error;
}> {}

export class TimeoutError extends Data.TaggedError('TimeoutError')<{
  readonly timeoutMs: number;
}> {}

// Utility function to create errors from unknown causes
export const createXRPCError = (
  status: number,
  message: string,
  headers?: Record<string, string>,
  error?: string,
) => {
  switch (status) {
    case 401:
      return new AuthenticationRequiredError({ status: 401 as const, message });
    case 403:
      return new ForbiddenError({ status: 403 as const, message });
    case 404:
      return new NotFoundError({ status: 404 as const, message });
    case 429:
      return new RateLimitExceededError({
        status: 429 as const,
        message,
        headers,
      });
    case 500:
      return new InternalServerError({ status: 500 as const, message });
    case 502:
      return new UpstreamFailureError({ status: 502 as const, message });
    default:
      return new XRPCError({ status, message, headers, error });
  }
};
