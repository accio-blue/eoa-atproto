import { Effect, Schema } from 'effect';
import {
  FRESH_PROOF,
  type NonceFields,
  REPLAYED_JTI,
  STALE_NONCE,
  STALE_NONCE_AND_REPLAYED_JTI,
  acceptsProof,
  freshNonceState,
  nonceChallenge,
  nonceStep,
  nonceSubmit,
} from '@eoa/oauth';
import { base64urlEncode } from '@eoa/crypto';

/**
 * The provider-side DPoP nonce store, which is the state behind
 * `packages/specs/specs/oauth/dpop-nonce.qnt`.
 *
 * The spec holds a current nonce and a monotone jti watermark; a proof is
 * accepted only when it presents the current nonce AND a jti at/above the
 * watermark, and acceptance consumes the nonce and advances the watermark. The
 * model in `@eoa/oauth` is the rule; this is where opaque wire values are
 * folded into it.
 *
 * **The mapping.** The spec counts with `bigint`, reality does not:
 *
 * - A nonce is a capability, not a quantity, so the spec's `nextNonce` counter is
 *   a *generation*. Each origin keeps one opaque random string as the current
 *   nonce; the counter turns over exactly when the spec says to (acceptance
 *   consumes it, a challenge replaces it) and a fresh string is minted then. The
 *   spec's `nonce === nextNonce` check is realized as `nonce === currentNonce`.
 * - A jti is an opaque random string with no order, so the spec's monotone
 *   *watermark* cannot be compared directly. It is realized as a seen-set that
 *   assigns each accepted jti the watermark value it was accepted at: an unseen
 *   jti maps to `nextJti` (at the watermark, accepted) and a replay maps to the
 *   sequence it was accepted at (behind the watermark, refused). `acceptsProof`
 *   then decides over those mapped counters, so the model's rule is the one that
 *   runs.
 *
 * The store is a port so a deployment can place it beside its other state; the
 * in-memory implementation below is the one a single process uses.
 */

/** Reported when the nonce state cannot be read or written. */
export class DpopNonceError extends Schema.TaggedError<DpopNonceError>()(
  'DpopNonceError',
  { message: Schema.String },
) {}

/** Why a proof was refused: a `nonce` failure earns a challenge, a `jti` does not. */
export type NonceRejection = 'nonce' | 'jti';

/** The outcome of folding one proof through the store. */
export interface NonceVerdict {
  /**
   * The nonce to hand back to the client: the consumed one rotated on
   * acceptance, or a replacement when the presented one was missing or stale.
   */
  readonly nonce: string;
  /** `undefined` when the proof is accepted, otherwise the check that failed. */
  readonly rejection: NonceRejection | undefined;
}

/** Where an origin's nonce and replay state live. */
export interface DpopNonceStore {
  /**
   * Fold a proof's nonce and jti into an origin's state. Acceptance consumes the
   * nonce and records the jti; a missing/stale nonce is replaced; a replay is
   * refused without consuming anything.
   */
  readonly verify: (params: {
    readonly origin: string;
    readonly nonce: string | undefined;
    readonly jti: string;
  }) => Effect.Effect<NonceVerdict, DpopNonceError>;
}

/** An opaque nonce: 32 random bytes, base64url. */
const mintNonce = (): string =>
  base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

/**
 * ponytail: the spec's watermark stands in for a seen-set, but real jtis have no
 * order, so this bounds the set by count rather than by the proof freshness
 * window. A pruned jti is replayable only inside that window and only after this
 * many accepts; add a time window if the cap ever becomes reachable.
 */
const JTI_CAP = 10_000;

interface OriginState {
  /** The spec's counters, driven by `nonceStep`. */
  readonly fields: NonceFields;
  /** The one opaque nonce this origin currently accepts. */
  readonly nonce: string;
  /** Accepted jti -> the watermark value it was accepted at. */
  readonly acceptedJtis: ReadonlyMap<string, bigint>;
}

const freshOriginState = (): OriginState => ({
  fields: freshNonceState(),
  nonce: mintNonce(),
  acceptedJtis: new Map(),
});

/** A fold's result: the next origin state and why the proof was refused, if it was. */
interface FoldedProof {
  readonly state: OriginState;
  readonly rejection: NonceRejection | undefined;
}

/** The spec's scenario label for the two facts a real proof presents. */
const scenarioFor = (params: {
  readonly accepted: boolean;
  readonly nonceOk: boolean;
  readonly jtiOk: boolean;
}): bigint => {
  if (params.accepted) {
    return FRESH_PROOF;
  }
  if (params.nonceOk) {
    return REPLAYED_JTI;
  }
  return params.jtiOk ? STALE_NONCE : STALE_NONCE_AND_REPLAYED_JTI;
};

const foldProof = (params: {
  readonly state: OriginState;
  readonly nonce: string | undefined;
  readonly jti: string;
}): FoldedProof => {
  const { state } = params;
  // The two facts the spec's scenario encodes, read off the opaque proof.
  const nonceOk = params.nonce === state.nonce;
  const assigned = state.acceptedJtis.get(params.jti);
  const jtiOk = assigned === undefined;

  // The provider's decision, over the counters the opaque values map to.
  const accepted = acceptsProof({
    state: state.fields,
    nonce: nonceOk ? state.fields.nextNonce : 0n,
    jti: assigned ?? state.fields.nextJti,
  });

  const scenario = scenarioFor({ accepted, nonceOk, jtiOk });
  const submitted = nonceStep({
    fields: state.fields,
    event: nonceSubmit({ scenario }),
  });
  // a stale/missing nonce earns a fresh one; a replay does not rotate
  const fields = nonceOk
    ? submitted
    : nonceStep({ fields: submitted, event: nonceChallenge() });

  const acceptedJtis = new Map(state.acceptedJtis);
  if (accepted) {
    acceptedJtis.set(params.jti, state.fields.nextJti);
    if (acceptedJtis.size > JTI_CAP) {
      const oldest = acceptedJtis.keys().next().value;
      if (oldest !== undefined) {
        acceptedJtis.delete(oldest);
      }
    }
  }

  // The opaque nonce turns over exactly when the spec's counter does.
  const turnedOver = fields.nextNonce !== state.fields.nextNonce;
  const nonce = turnedOver ? mintNonce() : state.nonce;

  return {
    state: { fields, nonce, acceptedJtis },
    rejection: accepted ? undefined : nonceOk ? 'jti' : 'nonce',
  };
};

/** A nonce store that forgets everything when the process ends. */
export const memoryDpopNonces = (): DpopNonceStore => {
  const origins = new Map<string, OriginState>();

  return {
    verify: ({ origin, nonce, jti }) =>
      Effect.sync(() => {
        const state = origins.get(origin) ?? freshOriginState();
        const folded = foldProof({ state, nonce, jti });
        origins.set(origin, folded.state);

        return {
          nonce: folded.state.nonce,
          rejection: folded.rejection,
        };
      }),
  };
};
