import { Effect, Metric } from 'effect';
import { type Middleware, XrpcError } from '@eoa/xrpc-server';

/**
 * The PDS's metrics (ticket `i1vo`, ADR 0009).
 *
 * Two shapes, and the split is the whole decision:
 *
 * - **Counters** only ever go up — a commit, a record write, an upload, a
 *   session minted, an account created, a refusal. The rate is what an alert
 *   watches.
 * - **Gauges** are a value at a moment — how many accounts and sessions exist,
 *   where the firehose is, and the store's own shape (its sequence, its runs by
 *   level, its held snapshots, its block cache). A gauge is read, not summed.
 *
 * The names are the contract: the dashboard's metrics view (`2dp7`) reads them
 * and the alerts key off them. They go out over OTLP — provide
 * `@eoa/observability`'s layer once at the app runtime edge — into the
 * o11y ingest. There is **no scrape endpoint**; the collector is the sink.
 */

/** Repo commits written. */
export const commits = Metric.counter('pds.commits', {
  description: 'Repo commits written',
});

/** Records written, by the write that did it (`create` | `update` | `delete`). */
export const recordsWritten = Metric.counter('pds.records.written', {
  description: 'Records written, by action',
});

/** Blob uploads accepted. */
export const blobsUploaded = Metric.counter('pds.blobs.uploaded', {
  description: 'Blobs uploaded',
});

/** Accounts created. */
export const accountsCreated = Metric.counter('pds.accounts.created', {
  description: 'Accounts created',
});

/** Account registrations refused, by reason. */
export const accountsRefused = Metric.counter('pds.accounts.refused', {
  description: 'Account registrations refused, by reason',
});

/** Sessions minted. */
export const sessionsCreated = Metric.counter('pds.sessions.created', {
  description: 'Sessions minted',
});

/** Sessions revoked. */
export const sessionsRevoked = Metric.counter('pds.sessions.revoked', {
  description: 'Sessions revoked',
});

/** XRPC requests, by method and status. */
export const requests = Metric.counter('pds.requests', {
  description: 'XRPC requests, by method and status',
});

/** Firehose subscriptions refused, by reason (`OutdatedCursor` | `FutureCursor`). */
export const firehoseRefused = Metric.counter('pds.firehose.refused', {
  description: 'Firehose subscriptions refused, by reason',
});

/** How many accounts the PDS holds, now. */
export const accounts = Metric.gauge('pds.accounts', {
  description: 'Accounts held, now',
});

/** How many sessions are live, now. */
export const sessions = Metric.gauge('pds.sessions', {
  description: 'Live sessions, now',
});

/** The firehose's latest sequence. */
export const firehoseCursor = Metric.gauge('pds.firehose.cursor', {
  description: 'The firehose sequence last written',
});

/** The store's head sequence. */
export const storeSequence = Metric.gauge('pds.store.sequence', {
  description: 'The store head sequence',
});

/** The store's runs, by level. */
export const storeRuns = Metric.gauge('pds.store.runs', {
  description: 'Store runs, by level',
});

/** Held snapshots the store must keep readable through compaction. */
export const storeHeldSnapshots = Metric.gauge('pds.store.held_snapshots', {
  description: 'Held store snapshots',
});

/** Entries in the store's block cache. */
export const storeBlockCacheEntries = Metric.gauge(
  'pds.store.block_cache_entries',
  { description: 'Store block cache entries' },
);

/** Count one refusal, labelled with why. */
export const refused = (reason: string) =>
  Metric.update(accountsRefused.pipe(Metric.withAttributes({ reason })), 1);

/**
 * Count every XRPC **method** by its method and the status it answered
 * (ADR 0009). A refusal is the same counter with its 4xx: the transport answers
 * an `XrpcError` with the status it carries, and anything else with a 500. Give
 * it to the server — `start({ middleware: [requestMetrics] })` — and every
 * method is counted.
 *
 * A stream is not a method and is not counted here: the firehose answers bytes
 * on a socket, and a refused cursor closes it rather than answering a status
 * (`pds.firehose.refused` is where that lands).
 */
export const requestMetrics: Middleware = (handler) => (ctx) =>
  handler(ctx).pipe(
    Effect.tap((result) => countRequest(ctx.nsid, statusOf(result))),
    Effect.tapError((error) => countRequest(ctx.nsid, statusOfError(error))),
  );

/** One request, by the method it asked for and the status it got. */
const countRequest = (method: string, status: number) =>
  Metric.update(
    requests.pipe(Metric.withAttributes({ method, status: String(status) })),
    1,
  );

/** A handler's answer as a status: a `Response` of its own says; JSON is a 200. */
const statusOf = <A>(result: A) =>
  result instanceof Response ? result.status : 200;

/** A failure's status: an `XrpcError` carries one; anything else is a 500. */
const statusOfError = <E>(error: E) =>
  error instanceof XrpcError ? error.status : 500;
