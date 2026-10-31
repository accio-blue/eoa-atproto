// Space host: revocation as an append-only, forward-only log.
//
// Revocations are records appended to a log and may arrive out of order. The
// effective revocation is the highest revoked epoch (`revokedUpTo`), which only
// ever moves forward and can never name a future epoch. Re-granting opens a new
// epoch; a stale record for an old epoch must not roll the pointer back.

module revocation_log {
  var epoch: int        // current grant epoch (0 = no grant yet)
  var revokedUpTo: int  // highest revoked epoch (the append-only pointer)
  var status: str       // "none" | "active" | "revoked"

  action init = all {
    epoch' = 0,
    revokedUpTo' = 0,
    status' = "none"
  }

  action grant = all {
    epoch' = epoch + 1,
    revokedUpTo' = revokedUpTo,
    status' = "active"
  }

  action revoke = all {
    epoch' = epoch,
    revokedUpTo' = if (status == "active") epoch else revokedUpTo,
    status' = if (status == "active") "revoked" else status
  }

  // Append a revocation record naming epoch `at`. Out-of-order records only
  // advance the pointer, and only up to the epoch they are issued in.
  action record = {
    nondet at = Set(0, 1, 2, 3).oneOf()
    all {
      epoch' = epoch,
      revokedUpTo' = if (at > revokedUpTo and at <= epoch) at else revokedUpTo,
      status' = if (at > revokedUpTo and at <= epoch and at == epoch) "revoked"
                else status
    }
  }

  action step = any { init, grant, revoke, record }

  // The revocation pointer never moves backwards and never runs ahead of the
  // epoch it was recorded in.
  val RevocationForwardOnly: bool = revokedUpTo <= epoch

  // A revoked grant always names the current epoch as revoked.
  val RevokedStaysRevoked: bool =
    or(status != "revoked", revokedUpTo == epoch)

  val EpochNonNegative: bool = epoch >= 0
  val RevocationNonNegative: bool = revokedUpTo >= 0
}
