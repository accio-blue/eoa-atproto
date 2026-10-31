// Notifications service: per-account cursor reconciliation after a gap.
//
// Each recipient holds a read cursor over the canonical notification sequence.
// A delivery advances the cursor only when it is the next contiguous
// notification; a forward gap parks the cursor and records where the sequence
// is missing. While a gap is open the account is "gapped" and further
// deliveries are ignored; reconciliation refetches the missing range from the
// canonical index and closes the gap, letting the cursor catch up to the head.
// The cursor never runs ahead of the canonical head, even mid-reconciliation.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/notifications/cursor-reconcile.test.ts).

module notifications_cursor_reconcile {
  var headSeq: int   // canonical notification sequence head
  var cursor: int    // account's contiguous read cursor
  var missingAt: int // first missing sequence while gapped (0 = none)
  var mode: str      // "synced" | "gapped"

  action init = all {
    headSeq' = 0,
    cursor' = 0,
    missingAt' = 0,
    mode' = "synced"
  }

  // Canonical notifications publish; the head moves forward.
  action publish = {
    nondet delta = Set(1, 2, 3).oneOf()
    all {
      headSeq' = headSeq + delta,
      cursor' = cursor,
      missingAt' = missingAt,
      mode' = mode
    }
  }

  // A delivery arrives at an offset from the cursor:
  //   1 -> contiguous: advance the cursor by one
  //   >1 -> forward gap: park and record the first missing sequence
  //   <=0 -> stale/duplicate: ignore
  // A gapped account ignores deliveries until it reconciles.
  action consume = {
    nondet offset = Set(1, 2, 4, 0, -1).oneOf()
    all {
      headSeq' = headSeq,
      cursor' = if (mode != "gapped" and offset == 1 and cursor < headSeq)
                  cursor + 1
                else cursor,
      missingAt' = if (mode != "gapped" and offset > 1 and cursor < headSeq)
                     cursor + 1
                   else missingAt,
      mode' = if (mode != "gapped" and offset > 1 and cursor < headSeq) "gapped"
              else if (mode != "gapped" and offset == 1 and cursor < headSeq) "synced"
              else mode
    }
  }

  // Reconciliation refetches the missing range from the canonical index. The
  // gap closes and the cursor catches up to the head exactly (which may have
  // advanced past the gap while reconciliation was pending).
  action reconcile = all {
    headSeq' = headSeq,
    cursor' = if (mode == "gapped") headSeq else cursor,
    missingAt' = if (mode == "gapped") 0 else missingAt,
    mode' = if (mode == "gapped") "synced" else mode
  }

  action step = any { init, publish, consume, reconcile }

  // The contiguous cursor never runs ahead of the canonical head.
  val CursorNeverAhead: bool = cursor <= headSeq

  // A recorded gap always names a sequence within the published head.
  val MissingWithinHead: bool = or(missingAt == 0, missingAt <= headSeq)

  val ModeValid: bool = or(mode == "synced", mode == "gapped")

  // "gapped" always names a missing sequence; "synced" always has none open.
  val GappedHasMissing: bool = or(mode != "gapped", missingAt > 0)
  val SyncedHasNoGap: bool = or(mode != "synced", missingAt == 0)

  val CountersNonNegative: bool = and(
    headSeq >= 0,
    cursor >= 0,
    missingAt >= 0
  )
}
