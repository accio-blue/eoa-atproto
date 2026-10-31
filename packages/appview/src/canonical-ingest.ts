import { type CborValue, CidLink, formatCid } from '@eoa/core';
import { Effect, Stream } from 'effect';
import { type IndexFrame, type LiveIngestError } from './live.js';
import {
  idleIngestion,
  ingestionApply,
  ingestionPipelineStep,
  ingestionProject,
  ingestionReceive,
  ingestionStart,
} from './ingestion-pipeline.js';
import { type CanonicalStoreShape } from './canonical-store.js';
import type { Json } from 'effect/Schema';
import { recordUri } from './ingest.js';

/**
 * The canonical ingest wire: our own live frames applied to the canonical
 * record store, in sequence order, through the pipeline rule
 * (`ingestion-pipeline.ts`, spec
 * `packages/specs/specs/appview/ingestion-pipeline.qnt`).
 *
 * Sequence: a frame's `time_us`. It is the stream's order, and a frame at or
 * below the transport cursor was applied on a previous connection, so it is a
 * stale/duplicate delivery - the spec's `delta <= 0` case, which the rule
 * ignores. A forward frame is the next delivery, so it is fed as `delta == 1`:
 * the rule buffers it, applies it, and projects it. The rule is the only thing
 * that decides an apply; this wire only translates `time_us` ordering into the
 * rule's `delta`.
 *
 * Gap: this wire has no gap detection. One live stream cannot tell a skipped
 * `time_us` from a jump, and the spec's forward gap (`delta > 1`) is a history
 * problem, not a live one - `backfill-cursor.ts` and the PDS backfill reconcile
 * history against the live stream around one cursor, and a live stream with no
 * backfill starts wherever the endpoint's cursor points. So this wire never
 * feeds `delta > 1` and never blocks; a buffer here would be a second opinion
 * the spec does not ask for.
 *
 * `projected`: there is no read projection yet, so `project` runs once per
 * applied record and `projected` advances in lockstep with `applied`. That is
 * honest - nothing is projected that was not applied, exactly the spec's
 * `projected <= applied` - and the stage machine drains back to `receiving`
 * between frames. It becomes a real projection when one exists.
 */

/** Apply live frames to the canonical store, in sequence order, through the
 *  pipeline rule. Returns the sequence reached and how many were applied. */
export const ingestCanonical: (params: {
  readonly store: CanonicalStoreShape;
  readonly frames: Stream.Stream<IndexFrame, LiveIngestError>;
  /** The sequence already applied on a previous connection. */
  readonly cursor?: bigint | undefined;
}) => Effect.Effect<
  { readonly cursor: bigint; readonly applied: number },
  LiveIngestError
> = (params) =>
  Stream.runFoldEffect(
    params.frames,
    () => ({
      fields: ingestionPipelineStep({
        fields: idleIngestion(),
        event: ingestionStart(),
      }),
      cursor: params.cursor,
    }),
    (state, frame) => {
      const time = BigInt(frame.time_us);
      const stale = state.cursor !== undefined && time <= state.cursor;
      const received = ingestionPipelineStep({
        fields: state.fields,
        event: ingestionReceive({ delta: stale ? 0n : 1n }),
      });

      // The rule buffers a forward delivery; a stale one leaves `buffered` at
      // the zero it always rests at between frames.
      if (received.buffered === 0n) {
        return Effect.succeed(state);
      }

      const applied = ingestionPipelineStep({
        fields: received,
        event: ingestionApply(),
      });
      const projected = ingestionPipelineStep({
        fields: applied,
        event: ingestionProject(),
      });

      return applyFrame({ store: params.store, frame }).pipe(
        Effect.as({ fields: projected, cursor: time }),
      );
    },
  ).pipe(
    Effect.map((state) => ({
      cursor: state.cursor ?? 0n,
      // The rule's own count, so the wire keeps no second tally.
      applied: Number(state.fields.applied),
    })),
  );

/** Apply one frame's record: an op with a value writes it, a delete removes it. */
export const applyFrame: (params: {
  readonly store: CanonicalStoreShape;
  readonly frame: IndexFrame;
}) => Effect.Effect<void> = (params) =>
  Effect.gen(function* () {
    const { store, frame } = params;
    const uri = recordUri({
      did: frame.did,
      collection: frame.collection,
      rkey: frame.rkey,
    });

    if (frame.record === undefined) {
      // A delete names no value; it removes the URI.
      yield* store.remove(uri);
      return;
    }

    yield* store.apply({
      uri,
      // The frame's CID, when the endpoint carried one. A delete has none (it
      // removes rather than writes), and a frame that somehow lost it gets the
      // empty string rather than a guess; the PDS backfill path holds a real
      // `{ uri, cid, value }` envelope and supplies one of its own.
      cid: frame.cid ?? '',
      value: asJsonValue(frame.record),
    });
  });

/**
 * The record's value in the store's JSON domain. The live wire renders records
 * as JSON (`live.ts` decodes the endpoint's JSON), so the value is already
 * JSON-safe; `CborValue` is simply the wider type the wire puts it in. A CID
 * link renders as `{$link}`, matching the PDS; a byte string or `undefined`,
 * which the JSON wire never carries, is a defect rather than a value to store.
 */
// Recursive, so TypeScript cannot infer the return type (TS7023); the
// annotation is required here, not stylistic.
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
function asJsonValue(value: CborValue): Json {
  if (value instanceof CidLink) {
    return { $link: formatCid(value.cid) };
  }
  if (value === undefined || value instanceof Uint8Array) {
    throw new Error('the live wire carried a record value JSON cannot hold');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => asJsonValue(entry));
  }
  if (value instanceof Object) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
    );
  }
  return value;
}
