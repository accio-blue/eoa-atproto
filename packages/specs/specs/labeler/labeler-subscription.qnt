// Labeler: the client's subscription to a labeler - the visibility decision.
//
// A client does not show every label it sees: it shows a label only when it has
// an active subscription to the labeler whose service record declares that
// value, and the label has not expired. This is exactly the shared fail-closed
// grant oracle (`shared/auth.qnt`): an absent, revoked, mismatched, undeclared,
// or expired case denies. The `visible` flag is the derived view of that oracle.
// The spec is the source of truth for the acceptance policy.

module labeler_subscription {
  import auth.* from "../../shared/auth"

  var subscription: str   // "none" | "active" | "revoked"
  var labelerMatch: bool  // the label's src is the subscribed labeler
  var declared: bool      // the value is declared by that labeler's service record
  var expired: bool       // the label has passed its `exp`
  var visible: bool       // derived view: the client shows this label

  // The client's visibility decision IS the shared grant oracle: active
  // subscription, matching labeler, declared value, and not expired.
  def viewOf(sub: str, matches: bool, declaredValue: bool, past: bool): bool =
    canView(sub, matches, declaredValue, past)

  action init = all {
    subscription' = "none",
    labelerMatch' = false,
    declared' = false,
    expired' = false,
    visible' = false
  }

  // The client subscribes to the labeler; labels already resolved re-project.
  action subscribe = all {
    subscription' = "active",
    labelerMatch' = labelerMatch,
    declared' = declared,
    expired' = expired,
    visible' = viewOf("active", labelerMatch, declared, expired)
  }

  // The client unsubscribes; the labeler's labels disappear from the view.
  action unsubscribe = all {
    subscription' = "revoked",
    labelerMatch' = labelerMatch,
    declared' = declared,
    expired' = expired,
    visible' = viewOf("revoked", labelerMatch, declared, expired)
  }

  // A label arrives from one of three origins: "foreign" (another labeler),
  // "unlisted" (the subscribed labeler, an undeclared value), or "listed" (the
  // subscribed labeler with a declared value).
  action resolve = {
    nondet origin = Set("foreign", "unlisted", "listed").oneOf()
    all {
      subscription' = subscription,
      labelerMatch' = if (origin == "foreign") false else true,
      declared' = if (origin == "listed") true else false,
      expired' = expired,
      visible' = viewOf(
        subscription,
        if (origin == "foreign") false else true,
        if (origin == "listed") true else false,
        expired
      )
    }
  }

  // The label's `exp` passes: an expired label is never shown.
  action expire = all {
    subscription' = subscription,
    labelerMatch' = labelerMatch,
    declared' = declared,
    expired' = true,
    visible' = viewOf(subscription, labelerMatch, declared, true)
  }

  action step = any { init, subscribe, unsubscribe, resolve, expire }

  val SubscriptionValid: bool = or(
    subscription == "none",
    subscription == "active",
    subscription == "revoked"
  )

  // Fail-closed: the visible view is exactly the shared oracle's decision.
  val VisibleIsOracle: bool = visible == viewOf(subscription, labelerMatch, declared, expired)

  // A label is never shown from an inactive subscription, a foreign labeler, an
  // undeclared value, or an expired label.
  val VisibleRequiresActive: bool = or(not(visible), subscription == "active")
  val VisibleRequiresMatch: bool = or(not(visible), labelerMatch)
  val VisibleRequiresDeclared: bool = or(not(visible), declared)
  val NotVisibleWhenExpired: bool = or(not(visible), not(expired))

  // A revoked subscription can never show a label.
  val RevokedNeverVisible: bool = or(subscription != "revoked", not(visible))
}
