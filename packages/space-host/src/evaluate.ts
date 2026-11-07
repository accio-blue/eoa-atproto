import type { ATURI, DID, NSID } from '@eoa/core';
import {
  type Action,
  type CidString,
  CollectionSelector,
  type Grant,
  type LensRef,
  type LookupError,
  type Selector,
  type StrongRef,
} from './grant.js';
import {
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
} from 'effect';
import {
  RevocationLog,
  type RevocationState,
  isRevoked,
} from './revocation.js';

/**
 * `checkAccess(space, did, action)` - permission-primitive.md section 9.2.
 *
 * The record is the truth. The evaluator is DEFAULT-DENY and FAIL-CLOSED: it
 * returns `Allow` only when a stored grant positively matches, and every
 * failure to find out (lookup error, timeout, missing lens) is a `Deny`, never
 * an allow and never a thrown error. There is no deny rule anywhere: a grant
 * can only say yes, so there is no precedence to get wrong.
 */

export type DenyReason =
  | 'no-grant'
  | 'revoked'
  | 'expired'
  | 'lens-missing'
  | 'lens-incompatible'
  | 'lens-mismatch'
  | 'lookup-failed'
  | 'timeout';

export type Decision = Data.TaggedEnum<{
  Allow: {
    readonly grant: StrongRef;
    /**
     * The fields the winning selector promised, when it promised a projection. A caller that gets
     * this returns those fields and no others; a grant without `fields` returns the whole record,
     * which is what an absent value means.
     */
    readonly fields?: ReadonlyArray<string>;
  };
  Deny: { readonly reason: DenyReason };
}>;
export const Decision = Data.taggedEnum<Decision>();

/** A grant as the host stores it: the record, its strongRef, and its epoch. */
export interface StoredGrant {
  readonly ref: StrongRef;
  /** The revocation epoch this grant was issued in (>= 1). */
  readonly epoch: number;
  readonly grant: Grant;
}

export type LensStatus = 'compatible' | 'missing' | 'incompatible';

/** Where grants live (host storage). Returns grants for the given subject DIDs. */
export class GrantStore extends Context.Service<
  GrantStore,
  {
    readonly grantsFor: (
      space: ATURI,
      subjects: ReadonlyArray<DID>,
    ) => Effect.Effect<ReadonlyArray<StoredGrant>, LookupError>;
  }
>()('@eoa/space-host/GrantStore') {
  static readonly layerInMemory = (grants: ReadonlyArray<StoredGrant>) =>
    Layer.succeed(
      GrantStore,
      GrantStore.of({
        grantsFor: (space, subjects) =>
          Effect.succeed(
            grants.filter(
              (stored) =>
                stored.grant.space === space &&
                subjects.includes(stored.grant.subject),
            ),
          ),
      }),
    );
}

/**
 * Roles are MEMBERSHIP LOOKUPS, not grant targets: `expand` returns the extra
 * subject DIDs (a role / member-list DID) the caller stands for in `space`,
 * resolved at read time. Grants still target a DID.
 */
export class Membership extends Context.Service<
  Membership,
  {
    readonly expand: (
      space: ATURI,
      did: DID,
    ) => Effect.Effect<ReadonlyArray<DID>, LookupError>;
  }
>()('@eoa/space-host/Membership') {
  /** No roles: only a grant addressed to the DID itself can match. */
  static readonly layerNone = Layer.succeed(
    Membership,
    Membership.of({ expand: () => Effect.succeed([]) }),
  );

  static readonly layerFrom = (
    expand: (space: ATURI, did: DID) => ReadonlyArray<DID>,
  ) =>
    Layer.succeed(
      Membership,
      Membership.of({
        expand: (space, did) => Effect.succeed(expand(space, did)),
      }),
    );
}

/** Resolves a grant's pinned lens against what the host currently has. */
export class LensRegistry extends Context.Service<
  LensRegistry,
  {
    readonly check: (lens: LensRef) => Effect.Effect<LensStatus, LookupError>;
  }
>()('@eoa/space-host/LensRegistry') {
  /**
   * Conservative compatibility: any cid change for the nsid is "incompatible",
   * an absent nsid is "missing". Swap in a smarter registry when lens
   * evolution rules exist.
   */
  static readonly layerFromCurrent = (current: ReadonlyMap<NSID, CidString>) =>
    Layer.succeed(
      LensRegistry,
      LensRegistry.of({
        check: (lens) => {
          const cid = current.get(lens.nsid);
          return Effect.succeed(
            cid === undefined
              ? 'missing'
              : cid === lens.cid
                ? 'compatible'
                : 'incompatible',
          );
        },
      }),
    );
}

export interface AccessRequest {
  readonly space: ATURI;
  readonly did: DID;
  readonly action: Action;
  /** The collection being touched. Without it (and `record`) nothing matches. */
  readonly collection?: NSID;
  /** The exact record being touched (its at-uri). */
  readonly record?: ATURI;
  /** The lens the caller wants to read through, if any. */
  readonly lens?: LensRef;
  /**
   * The fields the caller wants to touch (JSON Pointers), when it asks for less than the record.
   *
   * A request that names none asks for the whole record, which is why it never matches a selector
   * that promises a projection — the alternative would let a caller read around the grant.
   */
  readonly fields?: ReadonlyArray<string>;
  /** Evaluation time; defaults to the Clock. A request with `now` bypasses the cache. */
  readonly now?: DateTime.Utc;
}

/**
 * Whether a selector covers what the request asks for.
 *
 * A selector that names fields covers only a request that names some — all of them inside what was
 * promised. A request for the whole record therefore does not match it: a narrower grant must not be
 * readable as a wider one.
 */
const coversFields = (
  declared: ReadonlyArray<string> | undefined,
  requested: ReadonlyArray<string> | undefined,
): boolean => {
  if (declared === undefined) {
    return true;
  }
  if (requested === undefined || requested.length === 0) {
    return false;
  }
  return requested.every((field) => declared.includes(field));
};

const selectorMatches = (selector: Selector, request: AccessRequest): boolean =>
  (Schema.is(CollectionSelector)(selector)
    ? request.collection === selector.collection
    : request.record === selector.record.uri) &&
  coversFields(selector.fields, request.fields);

/**
 * Static scope: space, subject, action and selector all match. Returns the winning selector, which
 * carries the projection a caller has to honour.
 */
export const grantInScope = (
  grant: Grant,
  request: AccessRequest,
  subjects: ReadonlyArray<DID>,
): Selector | undefined =>
  grant.space === request.space &&
  subjects.includes(grant.subject) &&
  grant.actions.includes(request.action)
    ? grant.selectors.find((selector) => selectorMatches(selector, request))
    : undefined;

export interface Candidate extends StoredGrant {
  readonly revocation: RevocationState;
  /** `undefined` when the grant pins no lens. */
  readonly lensStatus: LensStatus | undefined;
}

const failureOf = (
  candidate: Candidate,
  request: AccessRequest,
  now: DateTime.Utc,
): DenyReason | undefined => {
  const { grant } = candidate;
  if (isRevoked(candidate.revocation, candidate.epoch)) {
    return 'revoked';
  }
  if (
    grant.expiry !== undefined &&
    DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(grant.expiry)
  ) {
    return 'expired';
  }
  if (grant.lens === undefined) {
    return undefined;
  }
  if (candidate.lensStatus === 'incompatible') {
    return 'lens-incompatible';
  }
  if (candidate.lensStatus !== 'compatible') {
    return 'lens-missing';
  }
  if (
    request.lens !== undefined &&
    (request.lens.nsid !== grant.lens.nsid ||
      request.lens.cid !== grant.lens.cid)
  ) {
    return 'lens-mismatch';
  }
  return undefined;
};

/**
 * The pure core: allow iff some in-scope candidate survives revocation, expiry
 * and lens checks. Otherwise deny with the first in-scope failure, or
 * `no-grant` when nothing was in scope.
 */
export const decide = (input: {
  readonly request: AccessRequest;
  readonly now: DateTime.Utc;
  readonly subjects: ReadonlyArray<DID>;
  readonly candidates: ReadonlyArray<Candidate>;
}): Decision => {
  const failures: Array<DenyReason> = [];
  for (const candidate of input.candidates) {
    const selector = grantInScope(
      candidate.grant,
      input.request,
      input.subjects,
    );
    if (selector === undefined) {
      continue;
    }
    const failure = failureOf(candidate, input.request, input.now);
    if (failure === undefined) {
      return Decision.Allow({
        grant: candidate.ref,
        ...(selector.fields === undefined ? {} : { fields: selector.fields }),
      });
    }
    failures.push(failure);
  }
  return Decision.Deny({ reason: failures[0] ?? 'no-grant' });
};

/** Optional decision cache seam. The record stays the truth: keep TTLs short. */
export interface DecisionCache {
  readonly get: (key: string) => Effect.Effect<Option.Option<Decision>>;
  readonly set: (key: string, decision: Decision) => Effect.Effect<void>;
}

/** In-memory TTL cache driven by the Clock (so tests can use TestClock). */
export const makeDecisionCache = (
  ttl: Duration.Input,
): Effect.Effect<DecisionCache> =>
  Effect.gen(function* () {
    const ttlMillis = Duration.toMillis(ttl);
    const entries = yield* Ref.make<
      ReadonlyMap<string, { readonly decision: Decision; readonly at: number }>
    >(new Map());
    return {
      get: (key) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const hit = (yield* Ref.get(entries)).get(key);
          return hit !== undefined && now - hit.at < ttlMillis
            ? Option.some(hit.decision)
            : Option.none();
        }),
      set: (key, decision) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          yield* Ref.update(entries, (all) =>
            new Map(all).set(key, { decision, at }),
          );
        }),
    };
  });

export interface CheckAccessOptions {
  /** Upper bound for all lookups; on expiry the answer is `Deny('timeout')`. */
  readonly timeout?: Duration.Input;
  readonly cache?: DecisionCache;
}

export const DEFAULT_ACCESS_TIMEOUT = Duration.seconds(2);

const cacheKeyOf = (request: AccessRequest): string =>
  [
    request.space,
    request.did,
    request.action,
    request.collection ?? '',
    request.record ?? '',
    [...(request.fields ?? [])].sort().join(','),
    request.lens?.nsid ?? '',
    request.lens?.cid ?? '',
  ].join('\n');

const resolve = (request: AccessRequest, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const grants = yield* GrantStore;
    const membership = yield* Membership;
    const revocations = yield* RevocationLog;
    const lenses = yield* LensRegistry;

    const expanded = yield* membership.expand(request.space, request.did);
    const subjects = [...new Set([request.did, ...expanded])];
    const stored = yield* grants.grantsFor(request.space, subjects);
    const candidates = yield* Effect.forEach(
      stored.filter(
        (entry) => grantInScope(entry.grant, request, subjects) !== undefined,
      ),
      Effect.fnUntraced(function* (entry) {
        const revocation = yield* revocations.state(entry.ref.uri);
        const lensStatus =
          entry.grant.lens === undefined
            ? undefined
            : yield* lenses.check(entry.grant.lens);
        return { ...entry, revocation, lensStatus };
      }),
    );
    return decide({ request, now, subjects, candidates });
  });

/** Transient answers must not be cached: the next call may well succeed. */
const isCacheable = Decision.$match({
  Allow: () => true,
  Deny: ({ reason }) => reason !== 'timeout' && reason !== 'lookup-failed',
});

export const checkAccess = Effect.fn('checkAccess')(function* (
  request: AccessRequest,
  options: CheckAccessOptions = {},
): Effect.fn.Return<
  Decision,
  never,
  GrantStore | Membership | RevocationLog | LensRegistry
> {
  const { cache } = options;
  const key =
    cache !== undefined && request.now === undefined
      ? cacheKeyOf(request)
      : undefined;
  if (cache !== undefined && key !== undefined) {
    const hit = yield* cache.get(key);
    if (Option.isSome(hit)) {
      return hit.value;
    }
  }

  const now = request.now ?? (yield* DateTime.now);
  const decision = yield* resolve(request, now).pipe(
    Effect.timeoutOrElse({
      duration: options.timeout ?? DEFAULT_ACCESS_TIMEOUT,
      orElse: () => Effect.succeed(Decision.Deny({ reason: 'timeout' })),
    }),
    Effect.catchTag('LookupError', () =>
      Effect.succeed(Decision.Deny({ reason: 'lookup-failed' })),
    ),
  );

  if (cache !== undefined && key !== undefined && isCacheable(decision)) {
    yield* cache.set(key, decision);
  }
  return decision;
});
