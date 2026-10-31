import { Data, Match } from 'effect';
import type { RelayJetstreamFilterEvent } from '@eoa/specs/src/relay/jetstream-filter.scaffolding.generated.js';

/**
 * The Jetstream projection, implemented against the spec
 * (`packages/specs/specs/relay/jetstream-filter.qnt`).
 *
 * Jetstream is a JSON view of the firehose filtered by collection. Every record
 * observed on the wire moves the accounting; only records whose collection
 * matches are emitted. The safety property is exact accounting - `seen ==
 * matched + dropped` - so a record is never both emitted and dropped, and never
 * neither. The spec fixes the collection it emits, and so does this: a filter
 * that takes a different one is a wire concern, not a change to the model.
 */

/** The collection the spec emits (and the only one it matches). */
const EMITTED_COLLECTION = 'app.bsky.feed.post';

/** The projection's fields, as the spec declares them. */
export type FilterFields = {
  readonly status: string;
  /** Records observed on the wire. */
  readonly seen: bigint;
  /** Records that passed the filter. */
  readonly matched: bigint;
  /** Records that were filtered out. */
  readonly dropped: bigint;
};

/** A projection that has not started. */
export const idleFilter = () => ({
  status: 'idle',
  seen: 0n,
  matched: 0n,
  dropped: 0n,
});

/** The spec's events, as constructors. */
type FilterEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly start: {};
  readonly record: { readonly collection: string };
  readonly pause: {};
  readonly resume: {};
  readonly stop: {};
}>;

export const {
  init: filterInit,
  start: filterStart,
  record: filterRecord,
  pause: filterPause,
  resume: filterResume,
  stop: filterStop,
} = Data.taggedEnum<FilterEventMap>();

/** Whether a collection is the one this projection emits. */
const isEmitted = (collection: string) => collection === EMITTED_COLLECTION;

/** One step of the spec's `step` action, exhaustive over its events. */
export const filterStep = (params: {
  readonly fields: FilterFields;
  readonly event: RelayJetstreamFilterEvent;
}) => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => idleFilter(),

      start: () => ({ ...fields, status: 'streaming' }),

      record: ({ collection }) => {
        if (fields.status !== 'streaming') {
          return fields;
        }
        // Exactly one of the two counters moves, which is what makes the
        // accounting exact.
        return isEmitted(collection)
          ? { ...fields, seen: fields.seen + 1n, matched: fields.matched + 1n }
          : { ...fields, seen: fields.seen + 1n, dropped: fields.dropped + 1n };
      },

      pause: () =>
        fields.status === 'streaming'
          ? { ...fields, status: 'paused' }
          : fields,

      resume: () =>
        fields.status === 'paused'
          ? { ...fields, status: 'streaming' }
          : fields,

      stop: () => ({ ...fields, status: 'idle' }),
    }),
  );
};
