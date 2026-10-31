// OAuth provider — the DPoP nonce / replay machine.
//
// A resource server holds a current DPoP nonce and a monotonically advancing
// jti watermark. A proof is accepted only when it presents the current nonce
// AND a jti at or above the watermark. On acceptance the nonce is consumed
// (rotated) and the watermark advances, so neither the nonce nor the jti can
// be replayed.
//
// One nondet selector (`scenario`) encodes the proof the client presents, so
// the accept decision is derived from the same pure defs the invariants use:
//   0 -> fresh proof (current nonce, fresh jti)      -> accepted
//   1 -> stale nonce, fresh jti                      -> rejected (nonce)
//   2 -> current nonce, already-seen jti (replay)    -> rejected (jti)
//   3 -> stale nonce and already-seen jti            -> rejected
//
// ponytail: a monotone jti watermark stands in for the server's seen-set; a
// real server prunes expired jtis. Widen to a windowed set if replay within
// the window matters.
module oauth_dpop_nonce {
  var phase: str          // "ready" | "accepted" | "rejected" (last submission)
  var nextNonce: int      // the nonce the server will accept
  var usedNonce: int      // the last consumed nonce (0 = none)
  var nextJti: int        // smallest jti watermark still acceptable
  var lastJti: int        // last jti that was consumed (0 = none)
  var presentedNonce: int // the nonce in the last submitted proof
  var presentedJti: int   // the jti in the last submitted proof
  var nonceOk: bool       // last proof's nonce matched
  var jtiOk: bool         // last proof's jti was fresh

  def submittedNonce(s: int): int =
    if (or(s == 0, s == 2)) nextNonce else nextNonce + 1
  def submittedJti(s: int): int =
    if (or(s == 0, s == 1)) nextJti else lastJti
  def nonceOkFor(s: int): bool = submittedNonce(s) == nextNonce
  def jtiOkFor(s: int): bool = submittedJti(s) >= nextJti
  def acceptedFor(s: int): bool = and(nonceOkFor(s), jtiOkFor(s))

  action init = all {
    phase' = "ready",
    nextNonce' = 1,
    usedNonce' = 0,
    nextJti' = 1,
    lastJti' = 0,
    presentedNonce' = 0,
    presentedJti' = 0,
    nonceOk' = false,
    jtiOk' = false
  }

  action submit = {
    nondet scenario = Set(0, 1, 2, 3).oneOf()
    all {
      phase' = if (acceptedFor(scenario)) "accepted" else "rejected",
      nextNonce' = if (acceptedFor(scenario)) nextNonce + 1 else nextNonce,
      usedNonce' = if (acceptedFor(scenario)) nextNonce else usedNonce,
      nextJti' = if (acceptedFor(scenario)) nextJti + 1 else nextJti,
      lastJti' = if (acceptedFor(scenario)) nextJti else lastJti,
      presentedNonce' = submittedNonce(scenario),
      presentedJti' = submittedJti(scenario),
      nonceOk' = nonceOkFor(scenario),
      jtiOk' = jtiOkFor(scenario)
    }
  }

  // the server may hand out a fresh nonce at any time
  action rotate = all {
    phase' = phase,
    nextNonce' = nextNonce + 1,
    usedNonce' = usedNonce,
    nextJti' = nextJti,
    lastJti' = lastJti,
    presentedNonce' = presentedNonce,
    presentedJti' = presentedJti,
    nonceOk' = nonceOk,
    jtiOk' = jtiOk
  }

  // a stale-nonce rejection is answered with a fresh nonce
  action challenge = all {
    phase' = phase,
    nextNonce' = if (and(phase == "rejected", not(nonceOk))) nextNonce + 1 else nextNonce,
    usedNonce' = usedNonce,
    nextJti' = nextJti,
    lastJti' = lastJti,
    presentedNonce' = presentedNonce,
    presentedJti' = presentedJti,
    nonceOk' = nonceOk,
    jtiOk' = jtiOk
  }

  action step = any { init, submit, rotate, challenge }

  // the consumed jti is behind the watermark: it can never be accepted again
  val NoReplay: bool = lastJti < nextJti
  // the consumed nonce is behind the current one: no second use is possible
  val NonceFresh: bool = usedNonce < nextNonce
  // an acceptance means both checks passed
  val AcceptedImpliesChecks: bool = or(not(phase == "accepted"), and(nonceOk, jtiOk))
  // a rejection always has a failed check behind it
  val RejectedImpliesReason: bool = or(not(phase == "rejected"), or(not(nonceOk), not(jtiOk)))
}
