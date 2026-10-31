import { Duration, Effect, Schedule } from 'effect';
import { HeadersMap, QueryParams } from './types.js';
import { TimeoutError } from './errors.js';

// Retry policies for network operations
export const exponentialBackoff = Schedule.exponential(
  Duration.millis(100),
  2.0,
).pipe(Schedule.jittered, Schedule.upTo({ duration: Duration.seconds(30) }));

export const retryPolicy = exponentialBackoff.pipe(
  Schedule.while(({ input }) => {
    const error = input as {
      _tag?: string;
      status?: number;
    } | null;
    // Retry on network errors and 5xx status codes
    return (
      error?._tag === 'NetworkError' ||
      (error?._tag === 'XRPCError' && (error?.status ?? 0) >= 500) ||
      error?._tag === 'TimeoutError'
    );
  }),
);

// Timeout utilities
export const withTimeout = <A, E>(
  effect: Effect.Effect<A, E>,
  timeoutMs: number,
): Effect.Effect<A, E | TimeoutError> =>
  Effect.timeout(effect, Duration.millis(timeoutMs)).pipe(
    Effect.mapError(() => new TimeoutError({ timeoutMs })),
  );

// Common async utilities
export const sleep = (ms: number): Effect.Effect<void> =>
  Effect.sleep(Duration.millis(ms));

// Resource management helpers
export const acquireRelease = <A, E>(
  acquire: Effect.Effect<A, E>,
  release: (resource: A) => Effect.Effect<void>,
) => Effect.acquireRelease(acquire, release);

// Utility for generating TIDs (Time IDs) - simplified version
export const generateTID = (): string => {
  const time = Date.now();
  const random = Math.floor(Math.random() * 0x10000000000000);
  // Convert to base36 string representation without BigInt
  const combined = time * 0x100000000 + random;
  return combined.toString(36).slice(-13);
};

// URL building utilities
export const buildURL = (
  base: string,
  path: string,
  params?: QueryParams,
): string => {
  const url = new URL(path, base);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
};

// Header utilities
export const mergeHeaders = (
  ...headers: (Record<string, string> | undefined)[]
): HeadersMap => {
  const result: HeadersMap = {};

  for (const header of headers) {
    if (header) {
      Object.assign(result, header);
    }
  }

  return result;
};
