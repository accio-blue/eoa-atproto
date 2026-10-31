// Backlink index (Constellation): visibility follows the subject.
//
// A backlink lookup answers "who references this subject?". Visibility follows
// the subject, not the backlink: a public subject's backlinks are visible to
// everyone, while a private subject's backlinks are visible only to a
// grant-holder. An unresolved subject yields no decision. The gate is
// fail-closed: a private subject is visible only when the shared grant oracle
// says the viewer may view it (active grant, matching subject, matching
// selector, not expired).
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/backlink-index/visibility-gate.test.ts).
module backlink_visibility_gate {
  import auth.* from "../../shared/auth"

  var visibility: str        // "none" | "public" | "private"
  var grant: str             // "none" | "active" | "revoked"
  var subjectMatchesViewer: bool
  var selectorOk: bool
  var expired: bool
  var requested: bool        // a lookup is pending
  var decision: str          // "none" | "visible" | "hidden"

  def allowed: bool =
    canView(grant, subjectMatchesViewer, selectorOk, expired)

  // public subjects are visible to all; private subjects need the grant oracle
  def visibleFor(v: str, permitted: bool): bool =
    or(v == "public", and(v == "private", permitted))

  action init = all {
    visibility' = "none",
    grant' = "none",
    subjectMatchesViewer' = false,
    selectorOk' = false,
    expired' = false,
    requested' = false,
    decision' = "none"
  }

  action setVisibility = {
    nondet v = Set("public", "private", "none").oneOf()
    all {
      visibility' = v,
      grant' = grant,
      subjectMatchesViewer' = subjectMatchesViewer,
      selectorOk' = selectorOk,
      expired' = expired,
      requested' = false,
      decision' = "none"
    }
  }

  action setGrant = {
    nondet g = Set("none", "active", "revoked").oneOf()
    all {
      visibility' = visibility,
      grant' = g,
      subjectMatchesViewer' = subjectMatchesViewer,
      selectorOk' = selectorOk,
      expired' = expired,
      requested' = false,
      decision' = "none"
    }
  }

  action setSubjectMatchesViewer = {
    nondet b = Set(true, false).oneOf()
    all {
      visibility' = visibility,
      grant' = grant,
      subjectMatchesViewer' = b,
      selectorOk' = selectorOk,
      expired' = expired,
      requested' = false,
      decision' = "none"
    }
  }

  action setSelectorOk = {
    nondet b = Set(true, false).oneOf()
    all {
      visibility' = visibility,
      grant' = grant,
      subjectMatchesViewer' = subjectMatchesViewer,
      selectorOk' = b,
      expired' = expired,
      requested' = false,
      decision' = "none"
    }
  }

  action setExpired = {
    nondet b = Set(true, false).oneOf()
    all {
      visibility' = visibility,
      grant' = grant,
      subjectMatchesViewer' = subjectMatchesViewer,
      selectorOk' = selectorOk,
      expired' = b,
      requested' = false,
      decision' = "none"
    }
  }

  // resolve a backlink lookup for the current subject
  action lookup = all {
    visibility' = visibility,
    grant' = grant,
    subjectMatchesViewer' = subjectMatchesViewer,
    selectorOk' = selectorOk,
    expired' = expired,
    requested' = true,
    decision' = if (visibility == "none") "none"
      else if (visibleFor(visibility, allowed)) "visible"
      else "hidden"
  }

  action step = any {
    init,
    setVisibility,
    setGrant,
    setSubjectMatchesViewer,
    setSelectorOk,
    setExpired,
    lookup
  }

  val VisibilityValid: bool = or(
    visibility == "none",
    visibility == "public",
    visibility == "private"
  )
  val DecisionValid: bool = or(
    decision == "none",
    decision == "visible",
    decision == "hidden"
  )
  // a private subject is visible only through the fail-closed grant oracle
  val PrivateRequiresGrant: bool = or(
    decision != "visible",
    visibility != "private",
    canView(grant, subjectMatchesViewer, selectorOk, expired)
  )
  // a public subject is never hidden from a lookup
  val PublicNeverHidden: bool = or(decision != "hidden", visibility != "public")
  // a decision is only ever produced by a lookup
  val NoDecisionWithoutLookup: bool = or(decision == "none", requested)
}
