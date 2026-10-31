import { Context, Data, Effect, Layer, Option, Schema } from 'effect';
import { Kv, absentCondition, deleteOp, putOp } from '@eoa/kv';
import type { KvError, Value } from '@eoa/kv';

/**
 * DPoP replay, as `dpop-nonce.qnt` states it (the Effect-PDS map, `27un`).
 *
 * The spec's machine has a current nonce **and** a jti watermark; a resource
 * server owes the second half — its `NoReplay` invariant, "the consumed jti is
 * behind the watermark: it can never be accepted again". A seen-set is the
 * honest implementation of that invariant, and the spec says so itself in its
 * own note ("a monotone jti watermark stands in for the server's seen-set; a
 * real server prunes expired jtis").
 *
 * The nonce half is a *challenge policy* — when to demand one, and how to hand
 * out a fresh one on rejection — and is not built here. A proof is already
 * single-use by `jti`, bound to one request by `htm`/`htu` and to one token by
 * `ath`, so a nonce buys a round trip rather than a check. It is the provider's
 * machine, and it is noted rather than guessed at.
 *
 * A jti's row *is* the record that it was used, and only the absent precondition
 * can create it — so two requests racing with the same jti cannot both win.
 */

/** How long a proof's jti must be remembered: its freshness window. */
const WINDOW_SECONDS = 300;

/** How many seen rows a sweep will look at. */
const SWEEP_LIMIT = 1000;

const seenKey = (jti: string) => `J/${jti}`;

const SeenSchema = Schema.Struct({
  jti: Schema.String,
  iat: Schema.Finite,
  seenAt: Schema.Finite,
});

const decodeSeen = Schema.decodeUnknownOption(
  Schema.fromJsonString(SeenSchema),
);
const encodeSeen = Schema.encodeSync(Schema.fromJsonString(SeenSchema));

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const utf8 = (value: string) => encoder.encode(value);

const text = (value: Value) => decoder.decode(value);

/** Whether a jti had been used before — a refusal is an outcome, not an error. */
export type ReplayOutcomeMap = Data.TaggedEnum<{
  readonly fresh: {};
  readonly seen: {};
}>;

export const { fresh: replayFresh, seen: replaySeen } =
  Data.taggedEnum<ReplayOutcomeMap>();

export interface ReplayParams {
  readonly jti: string;
  readonly iat: number;
  /** seconds since the epoch */
  readonly now: number;
}

export class DpopReplay extends Context.Service<
  DpopReplay,
  {
    readonly submit: (
      params: ReplayParams,
    ) => Effect.Effect<ReplayOutcomeMap, KvError>;
  }
>()('@eoa/atproto-pds/DpopReplay') {}

export const dpopReplayLayer = Layer.effect(
  DpopReplay,
  Effect.gen(function* () {
    const kv = yield* Kv;

    /**
     * Forget the jtis whose window has closed, so the set stays bounded by the
     * window rather than by uptime.
     *
     * // ponytail: a sweep per proof. Sweep on a timer, or every Nth proof, when
     * // the seen-set is large enough for the scan to show up.
     */
    const sweep = (now: number) =>
      Effect.gen(function* () {
        const page = yield* kv.scan({ prefix: 'J/', limit: SWEEP_LIMIT });
        const stale = page.entries.filter((entry) => {
          const decoded = decodeSeen(text(entry.value));
          return (
            Option.isSome(decoded) &&
            now - decoded.value.seenAt > WINDOW_SECONDS
          );
        });
        if (stale.length > 0) {
          yield* kv.batch(stale.map((entry) => deleteOp({ key: entry.key })));
        }
      });

    const submit = (params: ReplayParams) =>
      Effect.gen(function* () {
        yield* sweep(params.now);
        yield* kv.batch([
          putOp({
            key: seenKey(params.jti),
            value: utf8(
              encodeSeen({
                jti: params.jti,
                iat: params.iat,
                seenAt: params.now,
              }),
            ),
            condition: absentCondition(),
          }),
        ]);
        return replayFresh();
      }).pipe(
        // A refused precondition is the spec's invariant doing its work: this
        // jti was used, and it can never be accepted again.
        Effect.catchTag('KeyPreconditionFailed', () =>
          Effect.succeed(replaySeen()),
        ),
      );

    return DpopReplay.of({ submit });
  }),
);
