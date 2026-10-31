// The did:plc operation chain as a behavior-machine.
//
// Behavior: genesis (create) -> rotate -> rebind -> nullify, plus a terminal
// tombstone. It mirrors the directory's append/replay rules in
// packages/identity/src/did-operation-log.ts: an operation extends a logged
// operation by `prev`; extending anything but the canonical head NULLIFIES the
// tail (a fork truncates history, it never branches), and a tombstone is
// terminal. A did:plc IS the hash of its genesis operation, so no later
// operation may change the identifier.
//
// The generator's subset has no action guards, so preconditions are encoded as
// `if (canExtend(...)) new else current` in each assignment: an action fired in
// the wrong state is a no-op rather than an error.
module plc_op_chain {
  var lifecycle: str      // "empty" | "active" | "tombstoned"
  var did: str            // the account identifier, fixed by genesis
  var headKind: str       // "none" | "plc_operation" | "plc_tombstone"
  var rotationKey: str    // "none" | "keyA" | "keyB"
  var signingKey: str     // "none" | "sigA" | "sigB"
  var handle: str         // "none" | "alice.example.com" | "bob.example.com"
  var pds: str            // "none" | "pds.one" | "pds.two"
  var logLen: int         // every accepted operation, nullified included
  var canonicalLen: int   // operations that still count
  var nullified: int      // operations a fork has superseded
  var forkCount: int      // fork resolutions performed

  def canExtend(l: str, k: str): bool = l == "active" and k == "plc_operation"

  def canFork(l: str, k: str, n: int): bool =
    l == "active" and k == "plc_operation" and n >= 2

  action init = all {
    lifecycle' = "empty",
    did' = "none",
    headKind' = "none",
    rotationKey' = "none",
    signingKey' = "none",
    handle' = "none",
    pds' = "none",
    logLen' = 0,
    canonicalLen' = 0,
    nullified' = 0,
    forkCount' = 0
  }

  action create = all {
    lifecycle' = if (lifecycle == "empty") "active" else lifecycle,
    did' = if (lifecycle == "empty") "did:plc:genesis" else did,
    headKind' = if (lifecycle == "empty") "plc_operation" else headKind,
    rotationKey' = if (lifecycle == "empty") "keyA" else rotationKey,
    signingKey' = if (lifecycle == "empty") "sigA" else signingKey,
    handle' = if (lifecycle == "empty") "alice.example.com" else handle,
    pds' = if (lifecycle == "empty") "pds.one" else pds,
    logLen' = if (lifecycle == "empty") logLen + 1 else logLen,
    canonicalLen' = if (lifecycle == "empty") canonicalLen + 1 else canonicalLen,
    nullified' = nullified,
    forkCount' = forkCount
  }

  // Rotate the key that signs the op log (and the repo signing key).
  action rotate = {
    nondet newKey = Set("keyA", "keyB").oneOf()
    all {
      lifecycle' = lifecycle,
      did' = did,
      headKind' = headKind,
      rotationKey' = if (canExtend(lifecycle, headKind)) newKey else rotationKey,
      signingKey' = if (canExtend(lifecycle, headKind)) "sigB" else signingKey,
      handle' = handle,
      pds' = pds,
      logLen' = if (canExtend(lifecycle, headKind)) logLen + 1 else logLen,
      canonicalLen' = if (canExtend(lifecycle, headKind))
                        canonicalLen + 1
                      else canonicalLen,
      nullified' = nullified,
      forkCount' = forkCount
    }
  }

  // Rebind alsoKnownAs + the PDS service endpoint (a new handle points at its
  // own endpoint here, so the two move together).
  action rebind = {
    nondet target = Set("alice.example.com", "bob.example.com").oneOf()
    all {
      lifecycle' = lifecycle,
      did' = did,
      headKind' = headKind,
      rotationKey' = rotationKey,
      signingKey' = signingKey,
      handle' = if (canExtend(lifecycle, headKind)) target else handle,
      pds' = if (canExtend(lifecycle, headKind))
               (if (target == "alice.example.com") "pds.one" else "pds.two")
             else pds,
      logLen' = if (canExtend(lifecycle, headKind)) logLen + 1 else logLen,
      canonicalLen' = if (canExtend(lifecycle, headKind))
                        canonicalLen + 1
                      else canonicalLen,
      nullified' = nullified,
      forkCount' = forkCount
    }
  }

  // Fork resolution. Extending an ancestor appends one op and nullifies the
  // canonical tail of at least one op; the canonical chain becomes
  // [genesis, forkOp] (length 2). Extending the head is a plain append.
  action nullify = {
    nondet scope = Set("head", "ancestor").oneOf()
    all {
      lifecycle' = lifecycle,
      did' = did,
      headKind' = headKind,
      rotationKey' = rotationKey,
      signingKey' = signingKey,
      handle' = handle,
      pds' = pds,
      logLen' = if (scope == "ancestor" and canFork(lifecycle, headKind, canonicalLen))
                  logLen + 1
                else logLen,
      canonicalLen' = if (scope == "ancestor" and canFork(lifecycle, headKind, canonicalLen))
                        2
                      else canonicalLen,
      nullified' = if (scope == "ancestor" and canFork(lifecycle, headKind, canonicalLen))
                     nullified + (canonicalLen - 1)
                   else nullified,
      forkCount' = if (scope == "ancestor" and canFork(lifecycle, headKind, canonicalLen))
                     forkCount + 1
                   else forkCount
    }
  }

  action tombstone = all {
    lifecycle' = if (canExtend(lifecycle, headKind)) "tombstoned" else lifecycle,
    did' = did,
    headKind' = if (canExtend(lifecycle, headKind)) "plc_tombstone" else headKind,
    rotationKey' = rotationKey,
    signingKey' = signingKey,
    handle' = handle,
    pds' = pds,
    logLen' = if (canExtend(lifecycle, headKind)) logLen + 1 else logLen,
    canonicalLen' = if (canExtend(lifecycle, headKind))
                      canonicalLen + 1
                    else canonicalLen,
    nullified' = nullified,
    forkCount' = forkCount
  }

  action step = any { init, create, rotate, rebind, nullify, tombstone }

  // The identifier is fixed by genesis: rotation changes keys, never the DID.
  val DidStableAcrossRotation: bool =
    if (lifecycle == "empty") did == "none" else did == "did:plc:genesis"

  // A fork nullifies the tail instead of merging it: the canonical length plus
  // the nullified count is exactly the log length, and any fork implies at
  // least one nullified operation (a "merged" fork would break the sum).
  val ForkNullified: bool =
    (canonicalLen + nullified == logLen) and (forkCount == 0 or nullified > 0)

  val LifecycleValid: bool =
    lifecycle == "empty" or lifecycle == "active" or lifecycle == "tombstoned"

  val HeadKindValid: bool =
    headKind == "none" or headKind == "plc_operation" or headKind == "plc_tombstone"
}
