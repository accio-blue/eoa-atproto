import { Context, Effect, Layer, Option } from 'effect';
import type { Entry, KvError, Sequence } from '@eoa/kv';
import { Kv, deleteOp, putOp, versionCondition } from '@eoa/kv';

/**
 * A space's host-side state, and which repos this host holds in it.
 *
 * A space host owns two things that do not ride the account's own CAR (spaces
 * alpha, 2026-10-29, section 5b):
 *
 * - the **meta archive** - the policy, the state the policy keeps, and the
 *   writer set - which is what `exportSpaceMeta`/`importSpaceMeta` carry;
 * - the knowledge that an account's repo in the space is **here**, which is
 *   what `listSpaces` reports.
 *
 * The archive is kept as the bytes it arrived as, not as a decoded object: the
 * export has to be byte-identical to what was imported (section 5b), and every
 * reader that needs the policy parses those same bytes. Storing a decoded copy
 * would be a second representation that can disagree with the one on the wire.
 *
 * Rows:
 *
 * - `SP/{space}` - the meta archive, raw.
 * - `SPA/{authority}/{space}` - an index for `listSpaces`: the spaces this
 *   host is the authority of.
 * - `SPH/{did}/{space}` - an index for `listSpaces`: the spaces this host holds
 *   a repo in for `did`.
 *
 * The two indexes are separate rows rather than a scan of `SP/` so a listing
 * does not read every archive to answer which spaces exist.
 */

/** How many rows a single scan will read, like the other stores. */
const SCAN_LIMIT = 10_000;

const EMPTY = new Uint8Array();

const metaKey = (space: string) => `SP/${space}`;

const authorityUnder = (did: string) => `SPA/${did}/`;

const authorityKey = (did: string, space: string) =>
  `${authorityUnder(did)}${space}`;

const holdsUnder = (did: string) => `SPH/${did}/`;

const holdsKey = (did: string, space: string) => `${holdsUnder(did)}${space}`;

/** The keys under a prefix, as the values carried after it. */
const listed = (kv: Kv['Service'], prefix: string) =>
  kv
    .scan({ prefix, limit: SCAN_LIMIT })
    .pipe(
      Effect.map((page) =>
        page.entries.map((entry) => entry.key.slice(prefix.length)),
      ),
    );

export class SpaceStore extends Context.Service<
  SpaceStore,
  {
    /** The archive this host holds for `space`, if it holds one. */
    readonly meta: (
      space: string,
    ) => Effect.Effect<Option.Option<Uint8Array>, KvError>;
    /**
     * The archive **and the version it is at**, for a read-modify-write.
     *
     * `meta` answers the bytes, because every reader wants the policy; a changer wants the entry,
     * because the version is what makes its next write a compare-and-swap.
     */
    readonly metaVersioned: (
      space: string,
    ) => Effect.Effect<Option.Option<Entry>, KvError>;
    /**
     * Replace the archive **only if it is still the version the caller read**.
     *
     * `putMeta` is an import: a mover retries a whole archive, so replacing rather than appending is
     * the promise (section 5d). A member change is a read-modify-write instead, and two of them
     * racing must not silently lose one — the loser gets `KeyPreconditionFailed` and re-reads.
     */
    readonly replaceMeta: (params: {
      readonly space: string;
      readonly authority: string;
      readonly archive: Uint8Array;
      readonly expected: Sequence;
    }) => Effect.Effect<Sequence, KvError>;
    /**
     * Replace the archive for `space`. One write, so a retried import replaces
     * rather than appends - which is what section 5d promises a mover.
     */
    readonly putMeta: (params: {
      readonly space: string;
      readonly authority: string;
      readonly archive: Uint8Array;
    }) => Effect.Effect<Sequence, KvError>;
    /** Remember that this host holds `did`'s repo in `space`. */
    readonly recordHold: (params: {
      readonly space: string;
      readonly did: string;
    }) => Effect.Effect<Sequence, KvError>;
    /** Forget that this host holds `did`'s repo in `space` — what a delete takes back. */
    readonly forgetHold: (params: {
      readonly space: string;
      readonly did: string;
    }) => Effect.Effect<Sequence, KvError>;
    /**
     * Drop the archive and the authority's index row. The space stops existing here, which is what
     * `deleteSpace` promises the owner; a member's repo and its hold row are the member's business
     * and stay.
     */
    readonly deleteMeta: (params: {
      readonly space: string;
      readonly authority: string;
    }) => Effect.Effect<Sequence, KvError>;
    /** The spaces this host holds a repo in for `did`. */
    readonly heldBy: (
      did: string,
    ) => Effect.Effect<ReadonlyArray<string>, KvError>;
    /** The spaces this host is the authority of for `did`. */
    readonly authorityOf: (
      did: string,
    ) => Effect.Effect<ReadonlyArray<string>, KvError>;
    /**
     * The store this is backed by. Exposed so the write log can live in the same `Kv` as the archives:
     * a space repo is data, and a deployment that keeps its spaces but not their repos would lose both
     * on the next restart.
     */
    readonly kv: Kv['Service'];
  }
>()('@eoa/atproto-pds/SpaceStore') {}

export const spaceStoreLayer = Layer.effect(
  SpaceStore,
  Effect.gen(function* () {
    const kv = yield* Kv;

    return SpaceStore.of({
      metaVersioned: (space) => kv.get(metaKey(space)),
      meta: (space) =>
        kv
          .get(metaKey(space))
          .pipe(Effect.map(Option.map((entry) => entry.value))),
      replaceMeta: (params) =>
        kv.batch([
          putOp({
            key: metaKey(params.space),
            value: params.archive,
            condition: versionCondition({ version: params.expected }),
          }),
          putOp({
            key: authorityKey(params.authority, params.space),
            value: EMPTY,
          }),
        ]),
      putMeta: (params) =>
        kv.batch([
          putOp({ key: metaKey(params.space), value: params.archive }),
          putOp({
            key: authorityKey(params.authority, params.space),
            value: EMPTY,
          }),
        ]),
      recordHold: (params) => kv.put(holdsKey(params.did, params.space), EMPTY),
      kv,
      forgetHold: (params) =>
        kv.batch([deleteOp({ key: holdsKey(params.did, params.space) })]),
      deleteMeta: (params) =>
        kv.batch([
          deleteOp({ key: metaKey(params.space) }),
          deleteOp({ key: authorityKey(params.authority, params.space) }),
        ]),
      heldBy: (did) => listed(kv, holdsUnder(did)),
      authorityOf: (did) => listed(kv, authorityUnder(did)),
    });
  }),
);
