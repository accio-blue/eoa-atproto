import { Effect, Option, Schema } from 'effect';
import { deleteOp, putOp } from '@eoa/kv';
import type { Kv } from '@eoa/kv';

/**
 * Site build hooks: when a watched collection changes, the site's build is nudged —
 * once per site per window, not once per record.
 *
 * The debounce is the whole design. A bulk edit rewrites hundreds of documents,
 * and a hook per write would queue hundreds of builds; a site needs to hear "your
 * content moved" and nothing more. So a write **records** the site and a deadline
 * in a row, the deployment arms its timer for that deadline, and the timer sends
 * one request per site whose row is due. Writes inside the window move the
 * deadline, which is what turns 178 writes into one nudge.
 *
 * The unit is the **site**, not the PDS: one PDS may host many. A record's
 * `publication` names its site when the record carries one, and the account's DID
 * is the site otherwise — the key the deployment's hook map is looked up by.
 *
 * A send is attempted once and the row is cleared either way: a rebuild is
 * idempotent, and the next write is the retry. That is deliberate (`ponytail:`
 * one attempt per window, no queue and no backoff; a site that must not miss an
 * event should read the firehose instead, which is what the PDS also serves).
 */

const PENDING_PREFIX = 'W/';

/** How long a burst of writes waits for the rest of the burst. */
export const DEFAULT_DEBOUNCE_SECONDS = 30;

/** `<did>` or `<publication at-uri>` → the site's hook URL. */
export type WebhookHooks = Readonly<Record<string, string>>;

export interface WebhookEvent {
  readonly did: string;
  readonly collection: string;
  readonly rkey: string;
  /** The site this record belongs to, when the record says so. */
  readonly publication?: string | undefined;
}

export interface WebhookNotifier {
  /** Record that a site's content moved. Never fails: a write is not a webhook's hostage. */
  readonly note: (event: WebhookEvent) => Effect.Effect<void>;
}

export interface WebhookDependencies {
  readonly kv: Kv['Service'];
  readonly hooks: WebhookHooks;
  readonly debounceMs: number;
  /**
   * Which writes are a site's business. The content plugin owns this fact: the
   * PDS knows how to debounce a nudge, not which collections an application
   * considers published content, so a plugin answers and the core does not
   * name one.
   */
  readonly watched: (collection: string) => boolean;
  /** Arm the deployment's timer for `at` (a Durable Object's alarm, in practice). */
  readonly arm: (at: number) => void;
}

const PendingSchema = Schema.Struct({
  at: Schema.Finite,
  did: Schema.String,
  collection: Schema.String,
  rkey: Schema.String,
  publication: Schema.optionalKey(Schema.String),
});

type Pending = typeof PendingSchema.Type;

const encoder = new TextEncoder();

const utf8 = (value: string) => encoder.encode(value);

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PendingSchema));

const encode = Schema.encodeSync(Schema.fromJsonString(PendingSchema));

/** The site a record belongs to: its publication when named, else its account. */
export const siteOf = (event: WebhookEvent): string =>
  event.publication ?? event.did;

export const webhookNotifier = ({
  kv,
  hooks,
  debounceMs,
  watched,
  arm,
}: WebhookDependencies): WebhookNotifier => ({
  note: (event) =>
    Effect.gen(function* () {
      // Not a site's content: no row, no timer. What counts as content — and
      // that a draft does not — is the plugin's rule, asked once here.
      if (!watched(event.collection)) {
        return;
      }
      const site = siteOf(event);
      if (hooks[site] === undefined) {
        return;
      }
      const pending: Pending = {
        at: Date.now() + debounceMs,
        did: event.did,
        collection: event.collection,
        rkey: event.rkey,
        ...(event.publication === undefined
          ? {}
          : { publication: event.publication }),
      };
      yield* kv
        .batch([
          putOp({
            key: `${PENDING_PREFIX}${site}`,
            value: utf8(encode(pending)),
          }),
        ])
        .pipe(Effect.ignore);
      // The timer is the deployment's; a write only says when to wake it.
      arm(pending.at);
    }),
});

export interface FlushDependencies {
  readonly kv: Kv['Service'];
  readonly hooks: WebhookHooks;
  readonly now: number;
  readonly secret?: string | undefined;
  /** How a nudge is sent; a test passes a fake. */
  readonly post?: (params: {
    readonly url: string;
    readonly body: string;
    readonly secret: string | undefined;
  }) => Promise<void>;
}

const postWithFetch = async (params: {
  readonly url: string;
  readonly body: string;
  readonly secret: string | undefined;
}): Promise<void> => {
  const response = await fetch(params.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(params.secret === undefined ? {} : { 'x-cms-secret': params.secret }),
    },
    body: params.body,
  });
  if (!response.ok) {
    throw new Error(`the hook answered ${response.status}`);
  }
};

/**
 * Send every nudge whose window has closed, and clear the row.
 *
 * A row that fails is cleared too: the next write starts a new window, and a
 * site that needs certainty reads the firehose rather than waiting for a retry.
 */
export const flushWebhooks = ({
  kv,
  hooks,
  now,
  secret,
  post = postWithFetch,
}: FlushDependencies): Effect.Effect<void> =>
  Effect.gen(function* () {
    const page = yield* kv
      .scan({ prefix: PENDING_PREFIX, limit: 1000 })
      .pipe(Effect.orElseSucceed(() => ({ entries: [] })));
    const decoder = new TextDecoder();
    const due: Array<{ readonly key: string; readonly pending: Pending }> = [];
    for (const entry of page.entries) {
      const decoded = decode(decoder.decode(entry.value));
      if (Option.isSome(decoded) && decoded.value.at <= now) {
        due.push({ key: entry.key, pending: decoded.value });
      }
    }
    for (const { key, pending } of due) {
      const site = key.slice(PENDING_PREFIX.length);
      const url = hooks[site];
      if (url !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            post({
              url,
              secret,
              body: JSON.stringify({
                site,
                did: pending.did,
                collection: pending.collection,
                rkey: pending.rkey,
                at: new Date(pending.at).toISOString(),
              }),
            }),
          // One attempt, by design: the row is cleared whatever the answer was.
          catch: () => new Error('the hook could not be reached'),
        }).pipe(Effect.ignore);
      }
      yield* kv.batch([deleteOp({ key })]).pipe(Effect.ignore);
    }
  });
