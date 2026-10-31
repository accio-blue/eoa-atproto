import { Effect } from 'effect';

/**
 * Telling the apps that a space's access changed (`frxd`, `p6wp`).
 *
 * A credential verifies statelessly and lives two hours, so a space host cannot make one stop
 * working. What it *can* do is say so: when a space is deleted, or its policy is rewritten so an
 * app is no longer named, every app that was reading it is told, and a view that answered from
 * copies drops them instead of waiting for its next pull (or, worse, its next mint an hour later).
 *
 * The hooks are keyed by the space's **authority** — the account whose spaces those are — so a
 * deployment names one URL per group it hosts, not one per space.
 *
 * `ponytail:` one attempt, no queue and no retry; a receiver that missed it still hears the
 * refusal on its next pull, which is the fallback that made this worth doing in the first place.
 */
export interface SpaceHookEvent {
  /** The space that changed, as `at://…`. */
  readonly space: string;
  /** Who owned it: the DID the hook map is keyed by. */
  readonly authority: string;
  /**
   * `revoked` — the space is gone and nothing of it may be kept; `updated` — the policy was
   * replaced, and a receiver the new policy no longer names drops its copies.
   */
  readonly action: 'revoked' | 'updated';
  /**
   * The policy as it now stands, on an `updated`. A receiver that cannot read it must treat it as
   * a revocation: "I do not understand this" is not "I am still allowed".
   */
  readonly policy?: unknown;
}

export interface SpaceHooks {
  /** Tell every hook of this authority. Never fails: a delete is not a webhook's hostage. */
  readonly notify: (event: SpaceHookEvent) => Effect.Effect<void>;
}

/** A refuse-to-send, said once and forgotten; the caller has already done the thing. */
export interface SpaceHookOptions {
  /** `<authority did>` → the URL to post to, e.g. an AppView's `/space/changed`. */
  readonly hooks: Readonly<Record<string, string>>;
  /** Sent as `x-cms-secret`; an empty one sends no header, and a receiver must refuse that. */
  readonly secret: string | undefined;
  /** The network, injectable so a test can watch what is said. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

export const spaceHooksOf = (options: SpaceHookOptions): SpaceHooks => {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const clock = options.now ?? Date.now;
  return {
    notify: (event) =>
      Effect.forEach(
        Object.entries(options.hooks)
          .filter(([authority]) => authority === event.authority)
          .map(([, url]) => url),
        (url) =>
          Effect.tryPromise({
            try: () =>
              send(url, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  ...(options.secret === undefined || options.secret === ''
                    ? {}
                    : { 'x-cms-secret': options.secret }),
                },
                body: JSON.stringify({
                  space: event.space,
                  authority: event.authority,
                  action: event.action,
                  ...(event.policy === undefined
                    ? {}
                    : { policy: event.policy }),
                  at: clock(),
                }),
              }),
            catch: (cause) => new Error(String(cause)),
          }).pipe(
            Effect.flatMap((response) =>
              response.ok
                ? Effect.void
                : Effect.logWarning(
                    `${url} answered ${response.status} for ${event.space}`,
                  ),
            ),
            Effect.catch(() =>
              Effect.logWarning(
                `${url} could not be told about ${event.space}`,
              ),
            ),
          ),
        { concurrency: 'unbounded', discard: true },
      ),
  };
};
