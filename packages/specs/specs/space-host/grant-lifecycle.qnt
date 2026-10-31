// Space host: the grant lifecycle + CAS fail-closed.
//
// A per-space log head is written only through a grant. Issuing a grant
// snapshots the current head; a use must present that exact base (compare-and-
// swap). A revocation makes every later use deny, and a stale base must
// conflict without merging. The spec is the source of truth: the generated
// model document is the verification substrate.

module grant_lifecycle {
  var grant: str      // "none" | "active" | "revoked"
  var logHead: int       // committed per-space log head version
  var expected: int   // base version the pending use presents
  var outcome: str    // "none" | "issued" | "committed" | "conflict" | "denied" | "revoked"

  action init = all {
    grant' = "none",
    logHead' = 0,
    expected' = 0,
    outcome' = "none"
  }

  action issue = all {
    grant' = "active",
    logHead' = logHead,
    expected' = logHead,
    outcome' = "issued"
  }

  // A use presents a CAS base. `fresh` means the base still matches the head.
  // A revoked or absent grant denies; a stale base conflicts and the head must
  // NOT move (no merge).
  action use = {
    nondet fresh = Set(true, false).oneOf()
    all {
      grant' = grant,
      logHead' = if (grant == "active" and fresh) logHead + 1 else logHead,
      expected' = if (fresh) logHead else logHead + 1,
      outcome' = if (grant != "active") "denied"
                 else if (fresh) "committed"
                 else "conflict"
    }
  }

  action revoke = all {
    grant' = if (grant == "active") "revoked" else grant,
    logHead' = logHead,
    expected' = expected,
    outcome' = if (grant == "active") "revoked" else outcome
  }

  action step = any { init, issue, use, revoke }

  // A revoked grant can never be followed by a committed write.
  val GrantFailClosed: bool =
    or(grant != "revoked", outcome == "revoked", outcome == "denied")

  // A conflicting use leaves the head untouched: the base it presented stays
  // ahead of the head (a successful commit is exactly base + 1 == head).
  val NoMergeOnConflict: bool =
    or(outcome != "conflict", expected > logHead)

  val HeadNonNegative: bool = logHead >= 0
}
