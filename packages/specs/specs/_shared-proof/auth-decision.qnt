// _shared-proof: proves a spec can import shared/auth.qnt (the grant decision
// oracle) and that the decision is fail-closed. The `_shared-proof` path is
// reserved for proofs; it is not part of the service enumeration.
module shared_proof_auth_decision {
  import auth.* from "../../shared/auth"

  var grant: str // "none" | "active" | "revoked"
  var subjectOk: bool // the grant's subject matches the viewer
  var verb: str // "view" | "write" | "admin"
  var selectorOk: bool // the grant's selector matches the requested record
  var expired: bool
  var allowed: bool

  action init = all {
    grant' = "none",
    subjectOk' = false,
    verb' = "view",
    selectorOk' = false,
    expired' = false,
    allowed' = canAct("none", false, "view", false, false)
  }

  action setGrant = {
    nondet g = Set("none", "active", "revoked").oneOf()
    all {
      grant' = g,
      subjectOk' = subjectOk,
      verb' = verb,
      selectorOk' = selectorOk,
      expired' = expired,
      allowed' = canAct(g, subjectOk, verb, selectorOk, expired)
    }
  }

  action setSubjectOk = {
    nondet b = Set(true, false).oneOf()
    all {
      grant' = grant,
      subjectOk' = b,
      verb' = verb,
      selectorOk' = selectorOk,
      expired' = expired,
      allowed' = canAct(grant, b, verb, selectorOk, expired)
    }
  }

  action setVerb = {
    nondet v = Set("view", "write", "admin").oneOf()
    all {
      grant' = grant,
      subjectOk' = subjectOk,
      verb' = v,
      selectorOk' = selectorOk,
      expired' = expired,
      allowed' = canAct(grant, subjectOk, v, selectorOk, expired)
    }
  }

  action setSelectorOk = {
    nondet b = Set(true, false).oneOf()
    all {
      grant' = grant,
      subjectOk' = subjectOk,
      verb' = verb,
      selectorOk' = b,
      expired' = expired,
      allowed' = canAct(grant, subjectOk, verb, b, expired)
    }
  }

  action setExpired = {
    nondet b = Set(true, false).oneOf()
    all {
      grant' = grant,
      subjectOk' = subjectOk,
      verb' = verb,
      selectorOk' = selectorOk,
      expired' = b,
      allowed' = canAct(grant, subjectOk, verb, selectorOk, b)
    }
  }

  action step = any { init, setGrant, setSubjectOk, setVerb, setSelectorOk, setExpired }

  // allowed implies every precondition held — fail-closed
  val FailClosed: bool = or(
    not(allowed),
    and(isActive(grant), subjectOk, verbPermitted(verb), selectorOk, not(expired)),
  )

  // no permission without a live grant
  val NoGrantNoAccess: bool = or(isActive(grant), not(allowed))
}
