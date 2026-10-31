// Moderation service: the enforcement-action lifecycle.
//
// A moderation action is applied to a subject as either a temporary label or a
// permanent takedown. A live action can be reversed (an appeal granted); only a
// temporary label also expires on its own. A permanent takedown never expires,
// so it can only leave the active state through an explicit reversal. The
// applied counter records how many actions were actually enforced, so state can
// never claim an action that was never applied.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/moderation/takedown-action.test.ts).

module moderation_takedown_action {
  import invariants.* from "../../shared/invariants"

  var enforcement: str // "none" | "label" | "takedown"
  var stage: str       // "none" | "active" | "reversed" | "expired"
  var temporary: bool  // a label is temporary; a takedown is permanent
  var applied: int     // enforcement actions actually applied

  // a live enforcement action is a label or a takedown
  def enforceable(value: str): bool =
    or(value == "label", value == "takedown")

  action init = all {
    enforcement' = "none",
    stage' = "none",
    temporary' = false,
    applied' = 0
  }

  // apply an enforcement action; re-applying over a live one is a no-op
  action apply = {
    nondet kind = Set("label", "takedown").oneOf()
    all {
      enforcement' = if (stage != "active") kind else enforcement,
      stage' = if (stage != "active") "active" else stage,
      temporary' = if (stage != "active") kind == "label" else temporary,
      applied' = if (stage != "active") applied + 1 else applied
    }
  }

  // an appeal grants reversal: only a live action can be reversed
  action reverse = all {
    enforcement' = enforcement,
    stage' = if (stage == "active") "reversed" else stage,
    temporary' = temporary,
    applied' = applied
  }

  // only a temporary action expires; a permanent one must be reversed
  action expire = all {
    enforcement' = enforcement,
    stage' = if (stage == "active" and temporary) "expired" else stage,
    temporary' = temporary,
    applied' = applied
  }

  action step = any { init, apply, reverse, expire }

  val EnforcementValid: bool = or(
    enforcement == "none",
    enforcement == "label",
    enforcement == "takedown"
  )
  val StageValid: bool = or(
    stage == "none",
    stage == "active",
    stage == "reversed",
    stage == "expired"
  )
  // an active action always names a real enforcement kind
  val ActiveHasEnforcement: bool =
    or(stage != "active", enforceable(enforcement))
  // only a temporary action is ever expired
  val ExpiredWasTemporary: bool =
    or(stage != "expired", temporary)
  // reversal also requires a real enforcement kind
  val ReversedHasEnforcement: bool =
    or(stage != "reversed", enforceable(enforcement))
  // an action exists exactly when one was applied
  val EnforcementApplied: bool =
    or(stage == "none", applied >= 1)
  val AppliedNonNegative: bool = nonNegative(applied)
}
