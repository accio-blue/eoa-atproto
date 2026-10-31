// Payments service: the refund lifecycle as policy.
//
// A refund can only be requested against a settled charge, and at most one
// refund settles per charge: a duplicate request is a no-op and a second
// settlement is impossible. A declined refund (rejected) changes nothing and
// may be retried. Refunding never touches access - the access-decoupling
// machine owns that rule.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/payments/refund-lifecycle.test.ts).

module payments_refund_lifecycle {
  var stage: str          // "none" | "requested" | "refunded" | "rejected"
  var refunds: int        // settled refunds for this charge (0 or 1)
  var chargeSettled: bool // the underlying charge settled

  def canRequest(value: str): bool =
    or(value == "none", value == "rejected")

  action init = all {
    stage' = "none",
    refunds' = 0,
    chargeSettled' = false
  }

  // A charge settles; it never un-settles.
  action settleCharge = all {
    stage' = stage,
    refunds' = refunds,
    chargeSettled' = true
  }

  // Request a refund. Refused when there is no settled charge to refund or a
  // refund already settled (a duplicate request is a no-op).
  action requestRefund = all {
    stage' = if (chargeSettled and refunds == 0 and canRequest(stage)) "requested"
             else stage,
    refunds' = refunds,
    chargeSettled' = chargeSettled
  }

  // Process a pending refund: settling it is the one and only refund.
  action processRefund = {
    nondet cleared = Set(true, false).oneOf()
    all {
      stage' = if (stage == "requested" and cleared) "refunded"
               else if (stage == "requested" and not(cleared)) "rejected"
               else stage,
      refunds' = if (stage == "requested" and cleared) refunds + 1 else refunds,
      chargeSettled' = chargeSettled
    }
  }

  // Retry a rejected refund.
  action retryRefund = {
    nondet cleared = Set(true, false).oneOf()
    all {
      stage' = if (stage == "rejected" and cleared) "refunded"
               else if (stage == "rejected" and not(cleared)) "rejected"
               else stage,
      refunds' = if (stage == "rejected" and cleared) refunds + 1 else refunds,
      chargeSettled' = chargeSettled
    }
  }

  action step = any { init, settleCharge, requestRefund, processRefund, retryRefund }

  val StageValid: bool = or(
    stage == "none",
    stage == "requested",
    stage == "refunded",
    stage == "rejected"
  )
  // at most one refund settles per charge
  val RefundsBound: bool = and(refunds >= 0, refunds <= 1)
  val RefundedHasRefund: bool = or(stage != "refunded", refunds == 1)
  val RejectedHasNoRefund: bool = or(stage != "rejected", refunds == 0)
  // a refund only ever follows a settled charge
  val RefundRequiresCharge: bool = or(refunds != 1, chargeSettled)
  val RefundedRequiresCharge: bool = or(stage != "refunded", chargeSettled)
}
