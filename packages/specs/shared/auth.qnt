// shared/auth.qnt — the authorization decision oracle shared by every service.
//
// Authorization is a PURE decision over facts a service has already resolved:
// is the grant active, does the subject match the viewer, is the requested
// verb permitted, does the selector match, and is the grant still in time.
//
// The grant model is FLAT (no parent/child, no delegation) and POSITIVE-ONLY
// (no deny rules; narrower spaces make exceptions), and the decision is
// FAIL-CLOSED: every condition must hold, so an absent / revoked / expired /
// mismatched grant denies. The grant LIFECYCLE (issue / revoke / CAS) is a
// machine and lives in the space-host spec, not here.
//
// Pure defs only: import it with `import auth.* from "../shared/auth"`.
module auth {
  def isActive(grant: str): bool = grant == "active"

  def verbPermitted(verb: str): bool = verb == "view" or verb == "write"

  // allow only when every condition holds — no condition, no permission
  def canAct(grant: str, subjectMatchesViewer: bool, verb: str, selectorMatches: bool, expired: bool): bool =
    isActive(grant) and subjectMatchesViewer and verbPermitted(verb) and selectorMatches and not(expired)

  def canView(grant: str, subjectMatchesViewer: bool, selectorMatches: bool, expired: bool): bool =
    canAct(grant, subjectMatchesViewer, "view", selectorMatches, expired)

  def canWrite(grant: str, subjectMatchesViewer: bool, selectorMatches: bool, expired: bool): bool =
    canAct(grant, subjectMatchesViewer, "write", selectorMatches, expired)
}
