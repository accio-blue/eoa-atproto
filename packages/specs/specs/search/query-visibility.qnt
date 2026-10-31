// Search service: query results gated by subject visibility.
//
// A search query answers over the index, but visibility follows the subject,
// not the record: a public subject's documents are visible to everyone, while
// a private subject's documents are visible only to a grant-holder. An
// unresolved subject yields no decision. The gate is fail-closed: a private
// subject returns results only when the shared grant oracle says the viewer
// may view it (active grant, matching subject, matching selector, not expired).
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/search/query-visibility.test.ts).
module search_query_visibility {
  import auth.* from "../../shared/auth"

  var visibility: str // "none" | "public" | "private"
  var grant: str      // "none" | "active" | "revoked"
  var subjectMatchesViewer: bool
  var selectorOk: bool
  var expired: bool
  var requested: bool // a query is pending
  var decision: str   // "none" | "results" | "empty"

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

  // run the query for the current subject
  action runQuery = all {
    visibility' = visibility,
    grant' = grant,
    subjectMatchesViewer' = subjectMatchesViewer,
    selectorOk' = selectorOk,
    expired' = expired,
    requested' = true,
    decision' = if (visibility == "none") "none"
      else if (visibleFor(visibility, allowed)) "results"
      else "empty"
  }

  action step = any {
    init,
    setVisibility,
    setGrant,
    setSubjectMatchesViewer,
    setSelectorOk,
    setExpired,
    runQuery
  }

  val VisibilityValid: bool = or(
    visibility == "none",
    visibility == "public",
    visibility == "private"
  )
  val DecisionValid: bool = or(
    decision == "none",
    decision == "results",
    decision == "empty"
  )
  // a private subject returns results only through the fail-closed oracle
  val PrivateResultsRequireGrant: bool = or(
    decision != "results",
    visibility != "private",
    canView(grant, subjectMatchesViewer, selectorOk, expired)
  )
  // a public subject is never empty for a lookup
  val PublicNeverEmpty: bool = or(decision != "empty", visibility != "public")
  // a decision is only ever produced by running a query
  val NoDecisionWithoutQuery: bool = or(decision == "none", requested)
}
