import { type ATURI, type DID, type NSID } from '@eoa/core';
import {
  type CidString,
  type Grant,
  type GrantRevoke,
  type LensRef,
  type LookupError,
  type StrongRef,
  decodeGrant,
  decodeGrantRevoke,
} from './grant.js';
import { Context, Effect, Layer, Ref, Schema } from 'effect';
import {
  GrantStore,
  LensRegistry,
  type LensStatus,
  Membership,
  type StoredGrant,
} from './evaluate.js';
import { type MembershipEntry, rolesOf } from './space.js';
import {
  RevocationLog,
  type RevocationState,
  appendRevocation,
  initialRevocation,
  openEpoch,
} from './revocation.js';

/**
 * The space host's storage (permission-primitive.md section 9.2.5): grants live
 * with the host and are never broadcast, the member list backs role expansion,
 * and the lens registry resolves a grant's pinned lens. This is the in-memory
 * reference; a durable backend implements the same `HostStorage` service.
 */

/** One version of a lens: the cid a grant pins and the fields it returns. */
export interface LensVersion {
  readonly cid: CidString;
  readonly fields: ReadonlyArray<string>;
}

export class HostStorage extends Context.Service<
  HostStorage,
  {
    readonly putGrant: (record: StoredGrant) => Effect.Effect<void>;
    readonly grants: Effect.Effect<ReadonlyArray<StoredGrant>>;
    readonly putMember: (entry: MembershipEntry) => Effect.Effect<void>;
    readonly members: Effect.Effect<ReadonlyArray<MembershipEntry>>;
    readonly registerLens: (
      nsid: NSID,
      version: LensVersion,
    ) => Effect.Effect<void>;
    readonly lensVersions: (
      nsid: NSID,
    ) => Effect.Effect<ReadonlyArray<LensVersion>>;
    readonly readRevocation: (grant: ATURI) => Effect.Effect<RevocationState>;
    readonly writeRevocation: (
      grant: ATURI,
      state: RevocationState,
    ) => Effect.Effect<void>;
  }
>()('@eoa/space-host/HostStorage') {
  static readonly layerInMemory = Layer.effect(
    HostStorage,
    Effect.gen(function* () {
      const grants = yield* Ref.make<ReadonlyArray<StoredGrant>>([]);
      const members = yield* Ref.make<ReadonlyArray<MembershipEntry>>([]);
      const lenses = yield* Ref.make<
        ReadonlyMap<NSID, ReadonlyArray<LensVersion>>
      >(new Map());
      const revocations = yield* Ref.make<ReadonlyMap<ATURI, RevocationState>>(
        new Map(),
      );

      return HostStorage.of({
        putGrant: (record) =>
          Ref.update(grants, (all) => [
            ...all.filter((entry) => entry.ref.uri !== record.ref.uri),
            record,
          ]),
        grants: Ref.get(grants),
        putMember: (entry) => Ref.update(members, (all) => [...all, entry]),
        members: Ref.get(members),
        registerLens: (nsid, version) =>
          Ref.update(lenses, (all) =>
            new Map(all).set(nsid, [...(all.get(nsid) ?? []), version]),
          ),
        lensVersions: (nsid) =>
          Ref.get(lenses).pipe(Effect.map((all) => all.get(nsid) ?? [])),
        readRevocation: (grant) =>
          Ref.get(revocations).pipe(
            Effect.map((all) => all.get(grant) ?? initialRevocation),
          ),
        writeRevocation: (grant, state) =>
          Ref.update(revocations, (all) => new Map(all).set(grant, state)),
      });
    }),
  );
}

/**
 * A lens evolution is compatible when the newer version only ADDS fields:
 * nothing is removed or renamed (atproto Lexicon Evolution, lens-mental-model
 * §3.6). An unknown pinned cid is `missing`, so the grant fails closed.
 */
export const lensStatusOf = (
  versions: ReadonlyArray<LensVersion>,
  pinned: LensRef,
): LensStatus => {
  const match = versions.find((version) => version.cid === pinned.cid);
  const current = versions.at(-1);
  if (match === undefined || current === undefined) {
    return 'missing';
  }
  if (current.cid === pinned.cid) {
    return 'compatible';
  }
  const currentFields = new Set(current.fields);
  return match.fields.every((field) => currentFields.has(field))
    ? 'compatible'
    : 'incompatible';
};

/** The evaluator's `GrantStore`, backed by host storage. */
export const grantStoreFromHost: Layer.Layer<GrantStore, never, HostStorage> =
  Layer.effect(
    GrantStore,
    Effect.gen(function* () {
      const host = yield* HostStorage;
      return GrantStore.of({
        grantsFor: (space, subjects) =>
          host.grants.pipe(
            Effect.map((all) =>
              all.filter(
                (entry) =>
                  entry.grant.space === space &&
                  subjects.includes(entry.grant.subject),
              ),
            ),
          ),
      });
    }),
  );

/** The evaluator's `Membership`, backed by host storage's member list. */
export const membershipFromHost: Layer.Layer<Membership, never, HostStorage> =
  Layer.effect(
    Membership,
    Effect.gen(function* () {
      const host = yield* HostStorage;
      return Membership.of({
        expand: (space, did) =>
          host.members.pipe(
            Effect.map((entries) => rolesOf(entries, space, did)),
          ),
      });
    }),
  );

/** The evaluator's `LensRegistry`, backed by host storage's lens versions. */
export const lensRegistryFromHost: Layer.Layer<
  LensRegistry,
  never,
  HostStorage
> = Layer.effect(
  LensRegistry,
  Effect.gen(function* () {
    const host = yield* HostStorage;
    return LensRegistry.of({
      check: (lens) =>
        host
          .lensVersions(lens.nsid)
          .pipe(Effect.map((versions) => lensStatusOf(versions, lens))),
    });
  }),
);

/** All three evaluator services over one `HostStorage`. */
export const evaluatorLayersFromHost: Layer.Layer<
  GrantStore | Membership | LensRegistry,
  never,
  HostStorage
> = Layer.mergeAll(
  grantStoreFromHost,
  membershipFromHost,
  lensRegistryFromHost,
);

export class GrantIngestError extends Schema.TaggedError<GrantIngestError>()(
  'GrantIngestError',
  {
    reason: Schema.Literals(['decode', 'not-authority']),
    message: Schema.String,
  },
) {}

/**
 * The strongRef -> grant ingest shape: decode the stored record strictly, require
 * the space authority to have issued it, and put it in host storage. An already
 * present ref is replaced (a re-ingest of the same record is idempotent).
 */
export const ingestGrant = (input: {
  readonly ref: StrongRef;
  readonly record: unknown;
  readonly epoch: number;
  readonly authority: DID;
}): Effect.Effect<StoredGrant, GrantIngestError, HostStorage> =>
  Effect.gen(function* () {
    const grant: Grant = yield* decodeGrant(input.record).pipe(
      Effect.mapError(
        (error) =>
          new GrantIngestError({ reason: 'decode', message: String(error) }),
      ),
    );
    if (grant.issuedBy !== input.authority) {
      return yield* new GrantIngestError({
        reason: 'not-authority',
        message: `grant issued by ${grant.issuedBy}, not ${input.authority}`,
      });
    }
    const host = yield* HostStorage;
    const stored: StoredGrant = {
      ref: input.ref,
      epoch: input.epoch,
      grant,
    };
    yield* host.putGrant(stored);
    return stored;
  });

/**
 * The evaluator's `RevocationLog`, backed by host storage: the append-only log
 * is durable and shared rather than a process-local Ref.
 */
export const revocationLogFromHost: Layer.Layer<
  RevocationLog,
  never,
  HostStorage
> = Layer.effect(
  RevocationLog,
  Effect.gen(function* () {
    const host = yield* HostStorage;
    return RevocationLog.of({
      openEpoch: (grant) =>
        host.readRevocation(grant).pipe(
          Effect.flatMap((state) => {
            const next = openEpoch(state);
            return host
              .writeRevocation(grant, next)
              .pipe(Effect.as(next.epoch));
          }),
        ),
      append: (grant, epoch) =>
        host.readRevocation(grant).pipe(
          Effect.flatMap((state) => {
            const next = appendRevocation(state, epoch);
            return host.writeRevocation(grant, next).pipe(Effect.as(next));
          }),
        ),
      state: (grant) => host.readRevocation(grant),
    });
  }),
);

export class RevokeIngestError extends Schema.TaggedError<RevokeIngestError>()(
  'RevokeIngestError',
  {
    reason: Schema.Literals(['decode', 'unknown-grant', 'not-authority']),
    message: Schema.String,
  },
) {}

/**
 * The `ing.lexicon.grant.revoke` ingest path: the record's strongRef names the
 * exact grant version revoked, whose host-stored epoch the log is appended at.
 * Idempotent and out-of-order tolerant - a revoke of a superseded version maps
 * to an old epoch, which `appendRevocation` logs without moving the current one.
 */
export const ingestRevoke = (input: {
  readonly record: unknown;
  readonly authority: DID;
}): Effect.Effect<
  RevocationState,
  RevokeIngestError | LookupError,
  HostStorage | RevocationLog
> =>
  Effect.gen(function* () {
    const revoke: GrantRevoke = yield* decodeGrantRevoke(input.record).pipe(
      Effect.mapError(
        (error) =>
          new RevokeIngestError({ reason: 'decode', message: String(error) }),
      ),
    );
    const host = yield* HostStorage;
    const grants = yield* host.grants;
    const stored = grants.find(
      (entry) =>
        entry.ref.uri === revoke.grant.uri &&
        entry.ref.cid === revoke.grant.cid,
    );
    if (stored === undefined) {
      return yield* new RevokeIngestError({
        reason: 'unknown-grant',
        message: `no grant ${revoke.grant.uri} at ${revoke.grant.cid}`,
      });
    }
    if (stored.grant.issuedBy !== input.authority) {
      return yield* new RevokeIngestError({
        reason: 'not-authority',
        message: `grant issued by ${stored.grant.issuedBy}, not ${input.authority}`,
      });
    }
    const log = yield* RevocationLog;
    return yield* log.append(revoke.grant.uri, stored.epoch);
  });
