import { Data, Match } from 'effect';
import type { RelaySubscriptionCursorEvent } from '@eoa/specs/src/relay/subscription-cursor.scaffolding.generated.js';

/**
 * The relay's subscription cursor, implemented against the spec
 * (`packages/specs/specs/relay/subscription-cursor.qnt`).
 *
 * The spec is the source of truth: its scaffolding supplies the event protocol,
 * `packages/specs/test/relay/` verifies the model, and this is the runtime those
 * invariants are about - a pure rule function, with a differential test beside it
 * that replays `quint run` traces against the model.
 *
 * The rules, one line of the spec each:
 *
 * - `idle` -> `subscribing` -> `live`;
 * - a live `commit` with `delta == 1` advances the cursor, and sets `resume` to
 *   the new cursor plus one - **the request cursor never passes an unseen
 *   record**, which is the spec's `NoGapSkipped`;
 * - `delta <= 0` is stale or duplicate and changes nothing;
 * - `delta > 1` is a gap: backfill, and go live again when it drains, without the
 *   committed cursor jumping over the records that were not refetched;
 * - `degrade` counts a failure and backs off; `retry` subscribes again.
 */

/** The cursor's fields, as the spec declares them. */
export type CursorFields = {
  readonly status: string;
  /** The last committed upstream sequence number. */
  readonly cursor: bigint;
  /** The next sequence to request on (re)subscribe or backfill. */
  readonly resume: bigint;
  /** Consecutive connection failures. */
  readonly attempts: bigint;
};

/** A subscription that has not started. */
export const idleCursor = () => ({
  status: 'idle',
  cursor: 0n,
  resume: 1n,
  attempts: 0n,
});

/** The spec's events, as constructors. */
type CursorEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly subscribe: {};
  readonly open: {};
  readonly commit: { readonly delta: bigint };
  readonly backfill: {};
  readonly degrade: {};
  readonly retry: {};
}>;

export const {
  init: cursorInit,
  subscribe: cursorSubscribe,
  open: cursorOpen,
  commit: cursorCommit,
  backfill: cursorBackfill,
  degrade: cursorDegrade,
  retry: cursorRetry,
} = Data.taggedEnum<CursorEventMap>();

/** One step of the spec's `step` action, exhaustive over its events. */
export const cursorStep = (params: {
  readonly fields: CursorFields;
  readonly event: RelaySubscriptionCursorEvent;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleCursor(),

      subscribe: () => ({ ...fields, status: 'subscribing' }),

      open: () => ({ ...fields, status: 'live', attempts: 0n }),

      commit: ({ delta }) => {
        if (fields.status !== 'live') {
          return fields;
        }
        if (delta > 1n) {
          return { ...fields, status: 'backfilling' };
        }
        if (delta === 1n) {
          const cursor = fields.cursor + 1n;
          return { ...fields, cursor, resume: cursor + 1n };
        }
        // Stale or duplicate: the cursor does not move, and neither does the
        // request cursor.
        return fields;
      },

      backfill: () =>
        fields.status === 'backfilling'
          ? { ...fields, status: 'live' }
          : fields,

      degrade: () => ({
        ...fields,
        status: 'backoff',
        attempts: fields.attempts + 1n,
      }),

      retry: () => ({ ...fields, status: 'subscribing' }),
    }),
  );
};
