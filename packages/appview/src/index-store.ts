import { Context, Effect, Layer, Ref } from 'effect';
import {
  type TargetIndexFields,
  emptyTargetIndex,
  indexOffer,
  indexRetract,
  targetIndexStep,
} from './target-index.js';

/**
 * The backlink index's store: the (target, source) pairs, and the accounting
 * the spec fixes.
 *
 * The rule in `target-index.ts` is pure and cannot see the pairs, so the store
 * is what answers `novel`: it holds the pairs in a `Ref` and offers every
 * reference to `targetIndexStep`, so the counting is the spec's arithmetic
 * rather than a second opinion kept here. `backlinksOf` reads the pairs back in
 * the order each source was first seen.
 */

export type BacklinkRef = { readonly target: string; readonly source: string };

export interface IndexStoreShape {
  /** Offer one reference: true when the (target, source) pair was new. */
  readonly offer: (ref: BacklinkRef) => Effect.Effect<boolean>;
  /** Retract one reference (delete or reorg): true when one was there. */
  readonly retract: (ref: BacklinkRef) => Effect.Effect<boolean>;
  /**
   * Retract everything one source offered, and answer the targets it left.
   *
   * A delete's commit carries no record, so the targets it used to point at are not in it -- but the
   * index offered them once, so it knows them. Without this, a deleted comment stays a backlink for
   * ever: the pair is one the index should never have kept after the record went.
   */
  readonly retractSource: (source: string) => Effect.Effect<readonly string[]>;
  /** The sources referencing this subject, in the order they were first seen. */
  readonly backlinksOf: (target: string) => Effect.Effect<readonly string[]>;
  /** The rule's accounting, as the spec declares it. */
  readonly accounting: Effect.Effect<TargetIndexFields>;
}

export class IndexStore extends Context.Service<IndexStore, IndexStoreShape>()(
  '@eoa/appview/IndexStore',
) {}

/** The pairs and the spec's fields, moved together so an offer is atomic. */
type IndexState = {
  readonly pairs: ReadonlyMap<string, ReadonlySet<string>>;
  /** The same pairs the other way round: what one source points at, which is the only way a delete
   *  can know what to retract. */
  readonly sources: ReadonlyMap<string, ReadonlySet<string>>;
  readonly fields: TargetIndexFields;
};

export const indexStoreLayer: Layer.Layer<IndexStore> = Layer.effect(
  IndexStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<IndexState>({
      pairs: new Map(),
      sources: new Map(),
      fields: emptyTargetIndex(),
    });

    /**
     * Take one pair out, both ways round, through the spec's retraction so the accounting stays the
     * rule's. A pair that is not there answers false and changes nothing -- including the accounting,
     * because the rule's retraction only fires when it retracts.
     */
    const retractRef = (ref: BacklinkRef) =>
      Ref.modify(state, (current) => {
        const held = current.pairs.get(ref.target);
        if (held === undefined || !held.has(ref.source)) {
          return [false, current];
        }

        const remaining = new Set(held);
        remaining.delete(ref.source);
        const pairs = new Map(current.pairs);
        if (remaining.size === 0) {
          pairs.delete(ref.target);
        } else {
          pairs.set(ref.target, remaining);
        }

        const pointed = new Set(current.sources.get(ref.source) ?? []);
        pointed.delete(ref.target);
        const sources = new Map(current.sources);
        if (pointed.size === 0) {
          sources.delete(ref.source);
        } else {
          sources.set(ref.source, pointed);
        }

        return [
          true,
          {
            pairs,
            sources,
            fields: targetIndexStep({
              fields: current.fields,
              event: indexRetract(),
            }),
          } satisfies IndexState,
        ];
      });

    return {
      offer: (ref) =>
        Ref.modify(state, (current) => {
          const held = current.pairs.get(ref.target);
          const novel = held === undefined || !held.has(ref.source);
          const pairs = novel
            ? new Map(current.pairs).set(
                ref.target,
                new Set(held ?? []).add(ref.source),
              )
            : current.pairs;
          const from = current.sources.get(ref.source);
          const sources = novel
            ? new Map(current.sources).set(
                ref.source,
                new Set(from ?? []).add(ref.target),
              )
            : current.sources;

          return [
            novel,
            {
              pairs,
              sources,
              fields: targetIndexStep({
                fields: current.fields,
                event: indexOffer({
                  target: ref.target,
                  source: ref.source,
                  novel,
                }),
              }),
            },
          ];
        }),

      retract: retractRef,

      retractSource: (source) =>
        Effect.gen(function* () {
          // The source's own list, copied: `retractRef` rewrites it as it goes.
          const pointed = (yield* Ref.get(state)).sources.get(source);
          const gone: string[] = [];
          for (const target of [...(pointed ?? [])]) {
            if (yield* retractRef({ target, source })) {
              gone.push(target);
            }
          }
          return gone;
        }),

      backlinksOf: (target) =>
        Effect.map(Ref.get(state), (current) => [
          ...(current.pairs.get(target) ?? []),
        ]),

      accounting: Effect.map(Ref.get(state), (current) => current.fields),
    } satisfies IndexStoreShape;
  }),
);
