import { Data, Match } from 'effect';

/**
 * The DPoP nonce / replay machine, implemented against the spec
 * (`packages/specs/specs/oauth/dpop-nonce.qnt`).
 *
 * A resource server holds a current nonce and a jti watermark. A proof is
 * accepted only when it presents the current nonce AND a jti at or above the
 * watermark; on acceptance the nonce is consumed (rotated) and the watermark
 * advances, so neither can be replayed (`NoReplay`, `NonceFresh`).
 *
 * One difference from the spec is deliberate: the spec encodes the proof a client
 * presents as a `scenario` int, because a Quint action has no other way to take
 * the input. Here the proof is its two observable facts — the nonce and the jti
 * it carries — so a caller (the provider, in M2) submits a real proof and
 * `acceptsProof` decides it. The scenario selector stays, because the
 * differential test needs to drive the model exactly as the spec does.
 */

/** The server's DPoP state, as the spec declares it. */
export type NonceFields = {
  /** `"ready"`, or the outcome of the last submission: `"accepted"` / `"rejected"`. */
  readonly phase: string;
  /** The nonce the server will currently accept. */
  readonly nextNonce: bigint;
  /** The last consumed nonce (`0n` = none). */
  readonly usedNonce: bigint;
  /** The smallest jti still acceptable. */
  readonly nextJti: bigint;
  /** The last jti consumed (`0n` = none). */
  readonly lastJti: bigint;
  readonly presentedNonce: bigint;
  readonly presentedJti: bigint;
  readonly nonceOk: boolean;
  readonly jtiOk: boolean;
};

/** A server that has handed out no nonce yet and consumed nothing. */
export const freshNonceState = (): NonceFields => ({
  phase: 'ready',
  nextNonce: 1n,
  usedNonce: 0n,
  nextJti: 1n,
  lastJti: 0n,
  presentedNonce: 0n,
  presentedJti: 0n,
  nonceOk: false,
  jtiOk: false,
});

/*
 * The spec's `scenario` selector, as named values — the proof a client presents.
 * The differential test decodes the spec's `scenario` into one of these; the
 * provider never sees them, because it has the proof itself.
 */
export const FRESH_PROOF = 0n;
export const STALE_NONCE = 1n;
export const REPLAYED_JTI = 2n;
export const STALE_NONCE_AND_REPLAYED_JTI = 3n;

/** The nonce in a proof under `scenario`: fresh scenarios carry the current one. */
export const submittedNonce = ({
  nextNonce,
  scenario,
}: {
  readonly nextNonce: bigint;
  readonly scenario: bigint;
}): bigint =>
  scenario === FRESH_PROOF || scenario === REPLAYED_JTI
    ? nextNonce
    : nextNonce + 1n;

/** The jti in a proof under `scenario`: the replay scenarios carry the last seen one. */
export const submittedJti = ({
  nextJti,
  lastJti,
  scenario,
}: {
  readonly nextJti: bigint;
  readonly lastJti: bigint;
  readonly scenario: bigint;
}): bigint =>
  scenario === FRESH_PROOF || scenario === STALE_NONCE ? nextJti : lastJti;

/** A proof's nonce matches the server's current nonce. */
export const nonceOkFor = (params: {
  readonly nextNonce: bigint;
  readonly scenario: bigint;
}): boolean => submittedNonce(params) === params.nextNonce;

/** A proof's jti is at or above the watermark. */
export const jtiOkFor = (params: {
  readonly nextJti: bigint;
  readonly lastJti: bigint;
  readonly scenario: bigint;
}): boolean => submittedJti(params) >= params.nextJti;

/** The whole decision: both checks must hold. */
export const acceptedFor = (params: {
  readonly nextNonce: bigint;
  readonly nextJti: bigint;
  readonly lastJti: bigint;
  readonly scenario: bigint;
}): boolean =>
  nonceOkFor({ nextNonce: params.nextNonce, scenario: params.scenario }) &&
  jtiOkFor({
    nextJti: params.nextJti,
    lastJti: params.lastJti,
    scenario: params.scenario,
  });

/**
 * The decision for a real proof, which is what the provider calls: it sees the
 * nonce and the jti, not a scenario label.
 */
export const acceptsProof = (params: {
  readonly state: NonceFields;
  readonly nonce: bigint;
  readonly jti: bigint;
}): boolean =>
  params.nonce === params.state.nextNonce && params.jti >= params.state.nextJti;

/**
 * The spec's events, as constructors. `submit` takes the scenario label so the
 * differential test can drive the model directly; the provider folds a real proof
 * through `acceptsProof` instead.
 */
type NonceEventMap = Data.TaggedEnum<{
  readonly init: {};
  readonly submit: { readonly scenario: bigint };
  readonly rotate: {};
  readonly challenge: {};
}>;

export const {
  init: nonceInit,
  submit: nonceSubmit,
  rotate: nonceRotate,
  challenge: nonceChallenge,
} = Data.taggedEnum<NonceEventMap>();

/**
 * One step of the spec's `step` action, exhaustive over the events it declares.
 */
export const nonceStep = (params: {
  readonly fields: NonceFields;
  readonly event: NonceEventMap;
}): NonceFields => {
  const { fields, event } = params;

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      init: () => freshNonceState(),

      submit: ({ scenario }) => {
        const accepted = acceptedFor({
          nextNonce: fields.nextNonce,
          nextJti: fields.nextJti,
          lastJti: fields.lastJti,
          scenario,
        });
        return {
          ...fields,
          phase: accepted ? 'accepted' : 'rejected',
          // acceptance consumes the nonce and advances the watermark
          nextNonce: accepted ? fields.nextNonce + 1n : fields.nextNonce,
          usedNonce: accepted ? fields.nextNonce : fields.usedNonce,
          nextJti: accepted ? fields.nextJti + 1n : fields.nextJti,
          lastJti: accepted ? fields.nextJti : fields.lastJti,
          presentedNonce: submittedNonce({
            nextNonce: fields.nextNonce,
            scenario,
          }),
          presentedJti: submittedJti({
            nextJti: fields.nextJti,
            lastJti: fields.lastJti,
            scenario,
          }),
          nonceOk: nonceOkFor({ nextNonce: fields.nextNonce, scenario }),
          jtiOk: jtiOkFor({
            nextJti: fields.nextJti,
            lastJti: fields.lastJti,
            scenario,
          }),
        };
      },

      // the server may hand out a fresh nonce at any time
      rotate: () => ({ ...fields, nextNonce: fields.nextNonce + 1n }),

      // a stale-nonce rejection is answered with a fresh nonce
      challenge: () => ({
        ...fields,
        nextNonce:
          fields.phase === 'rejected' && !fields.nonceOk
            ? fields.nextNonce + 1n
            : fields.nextNonce,
      }),
    }),
  );
};
