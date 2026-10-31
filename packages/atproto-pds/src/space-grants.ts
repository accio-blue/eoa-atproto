import {
  ATURI,
  CODEC_DAG_CBOR,
  type CborValue,
  type DID,
  cidFromDigest,
  decodeCbor,
  formatCid,
} from '@eoa/core';
import {
  CidString as CidStringSchema,
  Grant,
  GrantRevoke,
  GrantStore,
  LensRegistry,
  LookupError,
  Membership,
  RevocationLog,
  type RevocationState,
  SpaceWriteLog,
  type StoredGrant,
  initialRevocation,
  spaceFromUri,
} from '@eoa/space-host';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { sha256 } from '@eoa/crypto';
import { toJson } from './repo.js';

/**
 * Grants over a space, read from **the authority's repo in that space**.
 *
 * `ing.lexicon.grant` is issued by the space authority and stored in the space
 * (permission-primitive.md §9.1), so the authority's repo is where every grant
 * that can matter lives. Reading only that repo is a structural answer to "who
 * may grant": a record a member wrote into their own repo is not a grant, not
 * because a check rejects it, but because nothing looks there. The evaluator
 * never compares `issuedBy`, so this is where that rule lives.
 *
 * One read per check: the authority's repo's state gives both the grants and the
 * `ing.lexicon.grant.revoke` companions, so a revocation costs no second lookup.
 *
 * What this does NOT model: roles (`Membership.expand` answers `[]` — the member
 * list is membership, not role expansion) and lenses (`LensRegistry` answers
 * `missing`, so a grant that pins a lens is denied, which is the fail-closed side
 * of a registry this host does not have).
 */

const GRANT_PREFIX = 'ing.lexicon.grant/';
const REVOKE_PREFIX = 'ing.lexicon.grant.revoke/';

/** The at-uri a record row sits at, given the repo that holds it. */
const uriOf = (did: string, key: string) => `at://${did}/${key}` as ATURI;

/** The bytes as a JSON value the record schemas can decode, or `None` when they are not CBOR. */
const valueOf = (bytes: Uint8Array) =>
  Effect.try({
    try: () => toJson(decodeCbor(bytes) as CborValue),
    catch: () => 'not-cbor' as const,
  }).pipe(Effect.option);

/**
 * A record's CID is the digest of its own bytes, as everywhere else in the repo.
 *
 * A row whose bytes cannot be digested is a corrupt log, not a missing grant: it
 * dies rather than becoming a denial, because a denial would say "no grant" about
 * something that may well be one.
 */
const cidOf = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const digest = yield* sha256(bytes);
    const formatted = formatCid(
      cidFromDigest({ codec: CODEC_DAG_CBOR, digest }),
    );
    return yield* Schema.decodeUnknownEffect(CidStringSchema)(formatted);
  }).pipe(Effect.orDie);

/** The row of one record in a space log, as a grant reader needs it. */
export interface GrantStateRow {
  readonly value: Uint8Array | undefined;
}

/** A space log's state for `(space, authority)`: what `SpaceWriteLog.state` answers. */
export type GrantState = ReadonlyMap<string, GrantStateRow>;

/** One grant record: its address, what it says, and the value a client reads. */
export interface GrantRow {
  readonly ref: StoredGrant['ref'];
  readonly grant: Grant;
  /** The record as stored, JSON-shaped: what `getAccess` hands back untouched. */
  readonly value: Schema.Json;
}

/**
 * The grants in `state` naming one of `subjects`, and every revocation beside them — **one read**, so
 * a decision and a listing cannot disagree about which revocations exist.
 *
 * A record that does not parse is not a grant: it is dropped rather than failing the whole read,
 * because the authority's repo holds every other record it wrote too. A revoked grant is still
 * returned, with its revocation in the map: "granted and revoked" is a different answer from
 * "never granted", and only the caller's question decides which one matters.
 */
export const grantsAndRevocations = (params: {
  readonly state: GrantState;
  readonly space: ATURI;
  readonly subjects: ReadonlyArray<DID>;
}): Effect.Effect<
  {
    readonly grants: ReadonlyArray<GrantRow>;
    readonly revocations: ReadonlyMap<string, RevocationState>;
  },
  LookupError
> =>
  Effect.gen(function* () {
    const failed = (message: string) =>
      new LookupError({ source: 'grant-store', message });
    const parsed = spaceFromUri(params.space);
    if (parsed === undefined) {
      return yield* Effect.fail(
        failed(`${params.space} is not a space address`),
      );
    }

    // Revocations first, keyed by the grant's at-uri: a revoke for a grant this answer will not
    // return is simply never asked about.
    const revocations = new Map<string, RevocationState>();
    for (const [key, row] of params.state) {
      if (!key.startsWith(REVOKE_PREFIX) || row.value === undefined) {
        continue;
      }
      const value = yield* valueOf(row.value);
      if (Option.isNone(value)) continue;
      const revoke = Option.getOrUndefined(
        Schema.decodeUnknownOption(GrantRevoke)(value.value),
      );
      if (revoke === undefined) continue;
      revocations.set(revoke.grant.uri, {
        epoch: 1,
        revokedUpTo: 1,
        status: 'revoked',
        records: [1],
      });
    }

    const grants: Array<GrantRow> = [];
    for (const [key, row] of params.state) {
      if (!key.startsWith(GRANT_PREFIX) || row.value === undefined) {
        continue;
      }
      const value = yield* valueOf(row.value);
      if (Option.isNone(value)) continue;
      const grant = Option.getOrUndefined(
        Schema.decodeUnknownOption(Grant)(value.value),
      );
      if (grant === undefined || !params.subjects.includes(grant.subject)) {
        continue;
      }
      grants.push({
        ref: {
          uri: uriOf(parsed.authority, key),
          cid: yield* cidOf(row.value),
        },
        grant,
        value: value.value,
      });
    }
    return { grants, revocations };
  });

/** One read's worth of grant state: the two stores `checkAccess` asks for. */
export class SpaceGrantStores extends Context.Service<
  SpaceGrantStores,
  {
    readonly grants: GrantStore['Service'];
    readonly revocations: RevocationLog['Service'];
  }
>()('@eoa/atproto-pds/SpaceGrantStores') {
  /**
   * Over this host's space log.
   *
   * ponytail: the revocation table is a plain `Map` that outlives a request, and a re-issued grant
   * keeps its old revoke (the epoch is always 1, because a revoke record names the grant, not a
   * version of it). A re-grant that must undo a revocation needs epochs, and the record schema
   * would have to carry them.
   */
  static readonly layer = Layer.effect(
    SpaceGrantStores,
    Effect.gen(function* () {
      const log = yield* SpaceWriteLog;
      const revocations = new Map<string, RevocationState>();
      const failed = (message: string) =>
        new LookupError({ source: 'grant-store', message });

      const grantsFor = (
        space: ATURI,
        subjects: ReadonlyArray<DID>,
      ): Effect.Effect<ReadonlyArray<StoredGrant>, LookupError> =>
        Effect.gen(function* () {
          const parsed = spaceFromUri(space);
          if (parsed === undefined) {
            return yield* Effect.fail(failed(`${space} is not a space address`));
          }
          const state = yield* log
            .state({ space, did: parsed.authority })
            .pipe(
              Effect.mapError(() =>
                failed(`the grants in ${space} could not be read`),
              ),
            );
          const read = yield* grantsAndRevocations({ state, space, subjects });
          // The table outlives a request (see the class comment), so what this read found is merged
          // into it rather than replacing it.
          for (const [uri, revocation] of read.revocations) {
            revocations.set(uri, revocation);
          }
          return read.grants.map((row) => ({
            ref: row.ref,
            epoch: 1,
            grant: row.grant,
          }));
        });

      return SpaceGrantStores.of({
        grants: GrantStore.of({ grantsFor }),
        revocations: RevocationLog.of({
          // Granting is a record write, which goes through the space's own log: this store only
          // reads, so opening an epoch is the constant the ledger starts from.
          openEpoch: () => Effect.succeed(1),
          append: (grant, epoch) =>
            Effect.succeed(
              epoch === 1
                ? {
                    epoch: 1,
                    revokedUpTo: 1,
                    status: 'revoked' as const,
                    records: [1],
                  }
                : (revocations.get(grant) ?? initialRevocation),
            ),
          state: (grant) =>
            Effect.succeed(revocations.get(grant) ?? initialRevocation),
        }),
      });
    }),
  );
}

/**
 * The four services `checkAccess` asks for, over this host's space log.
 *
 * A caller provides it once (the surface does, at registration) and every check runs against the
 * same log, which is what makes a grant written a moment ago visible.
 */
export const spaceGrantLayers: Layer.Layer<
  GrantStore | RevocationLog | Membership | LensRegistry,
  never,
  SpaceWriteLog
> = Layer.mergeAll(
  Layer.effect(
    GrantStore,
    SpaceGrantStores.pipe(Effect.map((held) => held.grants)),
  ),
  Layer.effect(
    RevocationLog,
    SpaceGrantStores.pipe(Effect.map((held) => held.revocations)),
  ),
  // Roles are a member list's business, and this host models members as policyState entries, not as
  // DIDs that stand for others. A caller is only themselves.
  Layer.succeed(
    Membership,
    Membership.of({ expand: () => Effect.succeed([]) }),
  ),
  // No lens registry here, so a grant that pins a lens is denied (`lens-missing`) - the fail-closed
  // side of a feature this host does not serve.
  Layer.succeed(
    LensRegistry,
    LensRegistry.of({ check: () => Effect.succeed('missing' as const) }),
  ),
).pipe(Layer.provide(SpaceGrantStores.layer));
