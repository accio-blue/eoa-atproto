// Payments service: the subscription lifecycle as policy.
//
// Payments is an EXTERNAL service, DECOUPLED from access: this machine models
// only the billing lifecycle of one subscription (intent -> active -> dunning
// -> lapse / cancel). Payment never gates access; that rule is verified by the
// access-decoupling machine, not here.
//
// `paid` means the current billing cycle settled. Beginning a fresh checkout
// clears it, so an intent is always unpaid and a failed intent returns to the
// absent state. A renewal that declines enters dunning (grace); a repeated
// decline lapses the subscription. The spec is the source of truth; the
// generated model document drives the spec-only verification
// (test/payments/subscription-lifecycle.test.ts).

module payments_subscription_lifecycle {
  var state: str          // "none" | "intent" | "active" | "grace" | "lapsed" | "canceled"
  var paid: bool          // the current billing cycle settled
  var failedRenewals: int // declined charges since the last settled one

  def isFresh(value: str): bool =
    or(value == "none", or(value == "lapsed", value == "canceled"))
  def canRenew(value: str): bool = value == "active"
  def inDunning(value: str): bool = value == "grace"
  def canCancel(value: str): bool =
    or(value == "intent", or(value == "active", value == "grace"))

  action init = all {
    state' = "none",
    paid' = false,
    failedRenewals' = 0
  }

  // A checkout begins. From an absent, lapsed or canceled state this starts a
  // fresh, unpaid intent; from an active or dunning subscription it is a no-op.
  action beginIntent = all {
    state' = if (isFresh(state)) "intent" else state,
    paid' = if (isFresh(state)) false else paid,
    failedRenewals' = if (isFresh(state)) 0 else failedRenewals
  }

  // The first charge settles -> active. A declined charge returns to absent.
  action settleIntent = {
    nondet cleared = Set(true, false).oneOf()
    all {
      state' = if (state == "intent" and cleared) "active"
               else if (state == "intent" and not(cleared)) "none"
               else state,
      paid' = if (state == "intent" and cleared) true else paid,
      failedRenewals' = failedRenewals
    }
  }

  // Auto-renew at period end. A cleared charge extends the paid cycle and
  // clears the failure streak; a declined charge starts dunning.
  action renew = {
    nondet cleared = Set(true, false).oneOf()
    all {
      state' = if (canRenew(state) and cleared) "active"
               else if (canRenew(state) and not(cleared)) "grace"
               else state,
      paid' = paid,
      failedRenewals' = if (canRenew(state) and not(cleared)) failedRenewals + 1
                        else if (canRenew(state) and cleared) 0
                        else failedRenewals
    }
  }

  // Retry the declined charge from dunning. A second decline lapses.
  action retryRenewal = {
    nondet cleared = Set(true, false).oneOf()
    all {
      state' = if (inDunning(state) and cleared) "active"
               else if (inDunning(state) and not(cleared)) "lapsed"
               else state,
      paid' = paid,
      failedRenewals' = if (inDunning(state) and not(cleared)) failedRenewals + 1
                        else if (inDunning(state) and cleared) 0
                        else failedRenewals
    }
  }

  // Voluntary cancellation from an intent or a paid subscription.
  action cancel = all {
    state' = if (canCancel(state)) "canceled" else state,
    paid' = paid,
    failedRenewals' = failedRenewals
  }

  action step = any { init, beginIntent, settleIntent, renew, retryRenewal, cancel }

  val StateValid: bool = or(
    state == "none",
    state == "intent",
    state == "active",
    state == "grace",
    state == "lapsed",
    state == "canceled"
  )
  // only a settled cycle makes a subscription active or dunning
  val ActiveImpliesPaid: bool = or(state != "active", paid)
  val GraceImpliesPaid: bool = or(state != "grace", paid)
  // a checkout starts unpaid: an intent has no settled cycle behind it
  val IntentUnpaid: bool = or(state != "intent", not(paid))
  // a settled cycle cannot exist in the absent state
  val NoPaymentInAbsentState: bool = or(not(paid), state != "none")
  // dunning only ever follows a declined charge
  val GraceHasFailure: bool = or(state != "grace", failedRenewals >= 1)
  val FailedRenewalsNonNegative: bool = failedRenewals >= 0
}
