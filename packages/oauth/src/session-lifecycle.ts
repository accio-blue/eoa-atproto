import { Data, Match } from 'effect';

/**
 * The OAuth session/token lifecycle, implemented against the spec
 * (`packages/specs/specs/oauth/session-lifecycle.qnt`).
 *
 * Same arrangement as `packages/atproto-pds`'s `account-store.ts`: the spec's
 * generated scaffolding supplies the event protocol, `packages/specs/test/oauth/`
 * verifies the model with the spec's invariants, and this is the runtime those
 * invariants are about — a pure rule function, with a differential test beside it
 * that replays `quint run` traces against the model.
 *
 * The rules, one line of the spec each:
 *
 * - `new` -> `par_pushed` -> `authorized` (a single-use code is minted) ->
 *   `issued` (exchanged once) -> `refreshed`;
 * - a code is exchanged **at most once**, and only when PKCE matches — a mismatch
 *   still burns the code (fail closed) but mints nothing (`NoTokenWithoutPkce`);
 * - refresh and access tokens rotate together, so refresh never outnumbers access
 *   (`RefreshWithinAccess`);
 * - a revoked grant can neither exchange nor refresh (`RevokedCannotRefresh`).
 */

/** The grant's fields, as the spec declares them. */
export type SessionFields = {
  readonly stage: string;
  readonly parPushed: boolean;
  readonly codeIssued: boolean;
  readonly codeUsed: boolean;
  readonly pkceVerified: boolean;
  readonly accessGeneration: bigint;
  readonly refreshGeneration: bigint;
  readonly refreshUsable: boolean;
  readonly revoked: boolean;
};

/** A grant that has not started: nothing pushed, nothing issued. */
export const newSession = (): SessionFields => ({
  stage: 'new',
  parPushed: false,
  codeIssued: false,
  codeUsed: false,
  pkceVerified: false,
  accessGeneration: 0n,
  refreshGeneration: 0n,
  refreshUsable: false,
  revoked: false,
});

/*
 * The spec's guard defs, as pure functions: the runtime and the invariant list
 * have to be reading the same rules. They are not exported — `sessionStep` is the
 * only way in, so the guards cannot be called out of the order the spec fixes.
 */

/** A code may be exchanged exactly once, and never after revocation. */
const canExchange = ({
  issued,
  used,
  revoked,
}: {
  readonly issued: boolean;
  readonly used: boolean;
  readonly revoked: boolean;
}): boolean => issued && !used && !revoked;

/** Exchange succeeds only when the code is live AND PKCE matches. */
const exchangeOk = (params: {
  readonly issued: boolean;
  readonly used: boolean;
  readonly revoked: boolean;
  readonly pkceMatch: boolean;
}): boolean => canExchange(params) && params.pkceMatch;

/** Refresh succeeds only while the refresh token is usable and not revoked. */
const canRefresh = ({
  usable,
  revoked,
}: {
  readonly usable: boolean;
  readonly revoked: boolean;
}): boolean => usable && !revoked;

/** The two stages in which a grant is live enough to deny or revoke. */
const inAuthorized = (stage: string): boolean =>
  stage === 'par_pushed' || stage === 'authorized';

/**
 * The spec's events, as constructors: a closed union of tagged objects, which is
 * what a tagged enum is for.
 */
type SessionEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly push_request: {};
  readonly authorize: {};
  readonly deny: {};
  readonly exchange: { readonly pkce: boolean };
  readonly refresh: {};
  readonly expire_refresh: {};
  readonly revoke: {};
}>;

export const {
  init: sessionInit,
  push_request: sessionPushRequest,
  authorize: sessionAuthorize,
  deny: sessionDeny,
  exchange: sessionExchange,
  refresh: sessionRefresh,
  expire_refresh: sessionExpireRefresh,
  revoke: sessionRevoke,
} = Data.taggedEnum<SessionEventMap>();

/**
 * One step of the spec's `step` action, exhaustive over the events it declares:
 * an event the spec grows has to be handled here before this compiles.
 */
export const sessionStep = (params: {
  readonly fields: SessionFields;
  readonly event: SessionEventMap;
}): SessionFields => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => newSession(),

      push_request: () =>
        fields.stage === 'new'
          ? { ...fields, stage: 'par_pushed', parPushed: true }
          : fields,

      authorize: () =>
        fields.stage === 'par_pushed'
          ? { ...fields, stage: 'authorized', codeIssued: true }
          : fields,

      // denial kills the grant wherever it was still live
      deny: () =>
        inAuthorized(fields.stage)
          ? { ...fields, stage: 'revoked', refreshUsable: false, revoked: true }
          : { ...fields, refreshUsable: false },

      exchange: ({ pkce }) => {
        const live = canExchange({
          issued: fields.codeIssued,
          used: fields.codeUsed,
          revoked: fields.revoked,
        });
        const ok = exchangeOk({
          issued: fields.codeIssued,
          used: fields.codeUsed,
          revoked: fields.revoked,
          pkceMatch: pkce,
        });
        return {
          ...fields,
          stage: ok ? 'issued' : fields.stage,
          // a PKCE mismatch still burns the code: fail closed
          codeUsed: live ? true : fields.codeUsed,
          pkceVerified: ok ? true : fields.pkceVerified,
          accessGeneration: ok
            ? fields.accessGeneration + 1n
            : fields.accessGeneration,
          refreshGeneration: ok
            ? fields.refreshGeneration + 1n
            : fields.refreshGeneration,
          refreshUsable: ok ? true : fields.refreshUsable,
        };
      },

      refresh: () => {
        const ok = canRefresh({
          usable: fields.refreshUsable,
          revoked: fields.revoked,
        });
        return {
          ...fields,
          stage: ok ? 'refreshed' : fields.stage,
          // both tokens rotate together
          accessGeneration: ok
            ? fields.accessGeneration + 1n
            : fields.accessGeneration,
          refreshGeneration: ok
            ? fields.refreshGeneration + 1n
            : fields.refreshGeneration,
        };
      },

      expire_refresh: () => ({ ...fields, refreshUsable: false }),

      revoke: () => ({
        ...fields,
        stage: fields.revoked ? fields.stage : 'revoked',
        refreshUsable: false,
        revoked: true,
      }),
    }),
  );
};
