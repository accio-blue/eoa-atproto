// AppView backfill vs live cursor reconciliation.
//
// A backfill replays history up to a target sequence while the live stream
// keeps delivering newer records. The two sources must reconcile around one
// cursor: live deliveries below the backfill point are ignored (history owns
// them), live deliveries beyond it are deferred until handover, and a stale
// backfill page never re-applies a sequence already covered. Reaching the
// target hands over to live; deferred deliveries then drain in order.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/appview/backfill-cursor.test.ts).
module appview_backfill_cursor {
  var mode: str           // "idle" | "backfilling" | "live"
  var target: int         // sequence the backfill must reach
  var backfillCursor: int // highest sequence covered by the backfill
  var liveCursor: int     // highest sequence applied from the live stream
  var deferred: int       // live deliveries held until handover

  action init = all {
    mode' = "idle",
    target' = 0,
    backfillCursor' = 0,
    liveCursor' = 0,
    deferred' = 0
  }

  // start a backfill to a nondeterministic target
  action startBackfill = {
    nondet startTarget = Set(2, 3, 5).oneOf()
    all {
      mode' = "backfilling",
      target' = startTarget,
      backfillCursor' = 0,
      liveCursor' = 0,
      deferred' = 0
    }
  }

  // one backfill page: a forward page advances to at most the target and
  // hands over when it reaches it; a stale page (seq <= covered) is ignored
  action backfillEvent = {
    nondet seq = Set(0, 1, 2, 3, 5).oneOf()
    all {
      mode' = if (mode == "backfilling" and seq >= target) "live" else mode,
      backfillCursor' = if (mode == "backfilling" and seq > backfillCursor)
        (if (seq >= target) target else seq)
        else backfillCursor,
      liveCursor' = if (mode == "backfilling" and seq >= target)
        target
        else liveCursor,
      target' = target,
      deferred' = deferred
    }
  }

  // one live delivery: ignored while history covers it, deferred when it is
  // beyond the target, applied once live; a stale delivery never moves back
  action liveEvent = {
    nondet seq = Set(0, 1, 2, 3, 5, 6).oneOf()
    all {
      mode' = mode,
      target' = target,
      backfillCursor' = backfillCursor,
      deferred' = if (mode == "backfilling" and seq > target)
        deferred + 1
        else deferred,
      liveCursor' = if (mode == "live" and seq > liveCursor) seq else liveCursor
    }
  }

  // after handover, replay deferred live deliveries in order
  action drainDeferred = all {
    mode' = mode,
    target' = target,
    backfillCursor' = backfillCursor,
    deferred' = if (mode == "live" and deferred > 0) deferred - 1 else deferred,
    liveCursor' = if (mode == "live" and deferred > 0)
      liveCursor + 1
      else liveCursor
  }

  action step = any { init, startBackfill, backfillEvent, liveEvent, drainDeferred }

  // the live stream never applies a sequence the backfill also covers: live
  // only ever starts at or beyond the handover point
  val NoDoubleApply: bool = or(liveCursor == 0, liveCursor >= target)
  // the backfill never runs past its target
  val BackfillWithinTarget: bool = backfillCursor <= target
  // once live, the cursor never sits below the handover point
  val CursorMonotonic: bool = or(mode != "live", liveCursor >= target)
  // reaching live implies the backfill reached the target first
  val HandoffConsistent: bool = or(mode != "live", backfillCursor == target)
  val CursorsNonNegative: bool = and(
    backfillCursor >= 0,
    liveCursor >= 0,
    deferred >= 0
  )
}
