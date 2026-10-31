// Payments service: payment NEVER gates access.
//
// The payment engine and the permission engine are separate: billing state and
// the access grant are independent variables, and the access decision is a
// function of the grant ALONE. A billing transition never changes the grant,
// never revokes an existing decision and never produces one: a lapsed or
// refunded subscription keeps whatever access the permission engine granted,
// and a paid subscription never gets access by paying.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/payments/access-decoupling.test.ts).

module payments_access_decoupling {
  var billing: str        // "none" | "active" | "grace" | "lapsed" | "refunded"
  var accessGrant: bool   // the permission engine's grant, set independently
  var accessDecision: str // "none" | "allowed" | "denied"

  def billingKnown(value: str): bool = or(
    value == "none",
    or(
      value == "active",
      or(value == "grace", or(value == "lapsed", value == "refunded"))
    )
  )

  action init = all {
    billing' = "none",
    accessGrant' = false,
    accessDecision' = "none"
  }

  // A billing transition: it changes billing and touches nothing else, so a
  // payment event can neither grant nor revoke access.
  action setBilling = {
    nondet value = Set("none", "active", "grace", "lapsed", "refunded").oneOf()
    all {
      billing' = value,
      accessGrant' = accessGrant,
      accessDecision' = accessDecision
    }
  }

  // The permission engine sets the grant; a stale decision is cleared.
  action setAccessGrant = {
    nondet granted = Set(true, false).oneOf()
    all {
      billing' = billing,
      accessGrant' = granted,
      accessDecision' = "none"
    }
  }

  // Evaluate access: reads the grant only, never billing.
  action evaluateAccess = all {
    billing' = billing,
    accessGrant' = accessGrant,
    accessDecision' = if (accessGrant) "allowed" else "denied"
  }

  action step = any { init, setBilling, setAccessGrant, evaluateAccess }

  val BillingValid: bool = billingKnown(billing)
  val DecisionValid: bool = or(
    accessDecision == "none",
    accessDecision == "allowed",
    accessDecision == "denied"
  )
  // access follows the grant alone: the payment state is irrelevant
  val AccessFollowsGrantOnly: bool = or(
    accessDecision == "none",
    and(accessDecision == "allowed", accessGrant),
    and(accessDecision == "denied", not(accessGrant))
  )
  // paying can never grant access
  val PaymentNeverGrantsAccess: bool = or(accessDecision != "allowed", accessGrant)
}
