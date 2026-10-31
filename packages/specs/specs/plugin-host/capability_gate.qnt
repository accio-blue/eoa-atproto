// Plugin host: the capability bridge, deny-by-default.
//
// The runtime hands a plugin capabilities only from its declared (signed)
// manifest: the bridge grants a requested capability iff that capability is
// declared, and denies everything else — an undeclared capability (here the
// never-declarable "admin") is always denied. Declaring or revoking a
// capability invalidates the last decision so the bridge re-evaluates.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/plugin-host/capability_gate.test.ts).
module capability_gate {
  var declaredRead: bool
  var declaredWrite: bool
  var requested: str    // "none" | "read" | "write" | "admin"
  var decision: str     // "none" | "granted" | "denied"

  action init = all {
    declaredRead' = false,
    declaredWrite' = false,
    requested' = "none",
    decision' = "none"
  }

  action declare = {
    nondet cap = Set("read", "write").oneOf()
    all {
      declaredRead' = if (cap == "read") true else declaredRead,
      declaredWrite' = if (cap == "write") true else declaredWrite,
      requested' = requested,
      decision' = "none"
    }
  }

  action revoke = {
    nondet cap = Set("read", "write").oneOf()
    all {
      declaredRead' = if (cap == "read") false else declaredRead,
      declaredWrite' = if (cap == "write") false else declaredWrite,
      requested' = requested,
      decision' = "none"
    }
  }

  // the bridge: grant iff the request is covered by the declared manifest
  action request = {
    nondet cap = Set("read", "write", "admin").oneOf()
    all {
      declaredRead' = declaredRead,
      declaredWrite' = declaredWrite,
      requested' = cap,
      decision' = if (cap == "read" and declaredRead) "granted"
        else if (cap == "write" and declaredWrite) "granted"
        else "denied"
    }
  }

  action step = any { init, declare, revoke, request }

  // no capability is granted unless the manifest declares it
  val DenyByDefault: bool =
    or(
      decision != "granted",
      and(requested == "read", declaredRead),
      and(requested == "write", declaredWrite)
    )

  val DecisionValid: bool =
    or(decision == "none", decision == "granted", decision == "denied")

  val RequestedValid: bool =
    or(
      requested == "none",
      requested == "read",
      requested == "write",
      requested == "admin"
    )
}
