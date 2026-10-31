import { type CborValue, decodeCbor } from '@eoa/core';
import { Effect } from 'effect';
import type { IndexStoreShape } from './index-store.js';
import { readCar } from '@eoa/repo';
import { referencesIn } from './references.js';

/**
 * The backlink index's ingest: what one commit touched, and what observing one
 * record does to the index.
 *
 * `recordsOfCommit` is the commit-shaped half of the extractor in
 * `link-extraction.ts`. The firehose hands over a CAR that is a *diff*, not a
 * whole repository, so only the blocks the operations name are decoded; an
 * operation whose block the CAR does not carry is dropped rather than guessed
 * at. `indexRecord` is the record-shaped half: every AT-URI the value carries
 * becomes one offer under that target, with the record's own URI as the source,
 * which is exactly one `link-extraction` observation of its references.
 */

/** One record a commit touched, with the value it carries. */
export type ObservedRecord = {
  readonly did: string;
  readonly collection: string;
  readonly rkey: string;
  /** Absent on a delete, which retracts rather than offers. */
  readonly record?: CborValue | undefined;
};

/** The record's AT-URI: `at://<did>/<collection>/<rkey>`. */
export const recordUri: (observed: ObservedRecord) => string = (observed) =>
  `at://${observed.did}/${observed.collection}/${observed.rkey}`;

/** One commit's records, decoded out of the CAR diff it carried. */
export const recordsOfCommit: (params: {
  readonly did: string;
  readonly ops: readonly {
    readonly action: string;
    readonly path: string;
    readonly cid: string | null;
  }[];
  readonly blocks: Uint8Array;
}) => Effect.Effect<readonly ObservedRecord[]> = (params) =>
  Effect.gen(function* () {
    const car = yield* readCar(params.blocks).pipe(Effect.orDie);

    return params.ops.flatMap((op) => {
      const block = op.cid === null ? undefined : car.blocks.get(op.cid);
      // A delete names no block. A create or update whose block the CAR omits
      // is not observable, so it is skipped: decoding from nothing, or offering
      // an absent value as if it were empty, would both be lies about a record
      // the diff did not carry.
      if (op.cid !== null && block === undefined) {
        return [];
      }

      const slash = op.path.indexOf('/');
      return [
        {
          did: params.did,
          collection: slash < 0 ? op.path : op.path.slice(0, slash),
          rkey: slash < 0 ? '' : op.path.slice(slash + 1),
          record: block === undefined ? undefined : decodeCbor(block.bytes),
        },
      ];
    });
  });

/** Index one observed record: offer each reference it carries, retract on delete.
 *  Returns the distinct targets it offered or retracted. */
export const indexRecord: (params: {
  readonly store: IndexStoreShape;
  readonly observed: ObservedRecord;
}) => Effect.Effect<readonly string[]> = (params) =>
  Effect.gen(function* () {
    const record = params.observed.record;
    if (record === undefined) {
      // A delete carries no value, so the commit does not say what this record used to point at.
      // The **index** does: every offer it accepted from this source is remembered the other way
      // round, so the delete retracts them all. Retracting nothing, which is what this did while the
      // store kept one direction, leaves a removed record a backlink for ever.
      // ponytail: retract a delete by feeding the previous record (or a
      // source-to-targets lookup) to `indexRecord`; add when deletes must
      // actually remove backlinks.
      return yield* params.store.retractSource(recordUri(params.observed));
    }

    const source = recordUri(params.observed);
    const targets = referencesIn(record);
    yield* Effect.forEach(
      targets,
      (target) => params.store.offer({ target, source }),
      { discard: true },
    );

    return targets;
  });
