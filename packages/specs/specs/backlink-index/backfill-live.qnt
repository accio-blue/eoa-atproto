// Backlink index (Constellation): backfill-vs-live cursor reconciliation.
//
// Our relays are non-archival, so historical references are backfilled by
// crawling PDSes while the live relay subscription keeps delivering newer
// references. The two sources reconcile around one ordinal cursor: live
// deliveries at or below the backfill point are already covered by history and
// are ignored, live deliveries beyond it are deferred until handover, and
// reaching the backfill target hands over to live. The index holds every
// ordinal either source covered, exactly once.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/backlink-index/backfill-live.test.ts).
module backlink_backfill_live {
  import base.* from "../../shared/base"

  var mode: str           // "idle" | "backfilling" | "live"
  var target: int         // ordinal the backfill must reach
  var backfillCursor: int // highest ordinal covered by the backfill
  var liveCursor: int     // highest ordinal applied from the live stream
  var deferred: int       // live deliveries held until handover
  var entries: int        // distinct indexed entries

  def maxOf(a: int, b: int): int = if (a > b) a else b

  action init = all {
    mode' = "idle",
    target' = 0,
    backfillCursor' = 0,
    liveCursor' = 0,
    deferred' = 0,
    entries' = 0
  }

  action startBackfill = {
    nondet startTarget = Set(2, 3, 5).oneOf()
    all {
      mode' = "backfilling",
      target' = startTarget,
      backfillCursor' = 0,
      liveCursor' = 0,
      deferred' = 0,
      entries' = 0
    }
  }

  // one backfill page: a forward page advances to at most the target and hands
  // over when it reaches it; a stale page (already covered) is ignored
  action backfillPage = {
    nondet seq = Set(0, 1, 2, 3, 5).oneOf()
    all {
      mode' = if (mode == "backfilling" and seq >= target) "live" else mode,
      target' = target,
      backfillCursor' = if (mode == "backfilling" and seq > backfillCursor)
        (if (seq >= target) target else seq)
        else backfillCursor,
      liveCursor' = if (mode == "backfilling" and seq >= target)
        target
        else liveCursor,
      deferred' = deferred,
      entries' = maxOf(
        if (mode == "backfilling" and seq > backfillCursor)
          (if (seq >= target) target else seq)
          else backfillCursor,
        if (mode == "backfilling" and seq >= target) target else liveCursor
      )
    }
  }

  // one live delivery: ignored while history covers it, deferred when it is
  // beyond the target, applied once live
  action liveEvent = {
    nondet seq = Set(0, 1, 2, 3, 5, 6).oneOf()
    all {
      mode' = mode,
      target' = target,
      backfillCursor' = backfillCursor,
      liveCursor' = if (mode == "live" and seq > liveCursor) seq else liveCursor,
      deferred' = if (mode == "backfilling" and seq > target)
        deferred + 1
        else deferred,
      entries' = maxOf(
        backfillCursor,
        if (mode == "live" and seq > liveCursor) seq else liveCursor
      )
    }
  }

  // after handover, replay deferred live deliveries in order
  action drainDeferred = all {
    mode' = mode,
    target' = target,
    backfillCursor' = backfillCursor,
    liveCursor' = if (mode == "live" and deferred > 0)
      liveCursor + 1
      else liveCursor,
    deferred' = if (mode == "live" and deferred > 0) deferred - 1 else deferred,
    entries' = maxOf(
      backfillCursor,
      if (mode == "live" and deferred > 0) liveCursor + 1 else liveCursor
    )
  }

  action step = any {
    init,
    startBackfill,
    backfillPage,
    liveEvent,
    drainDeferred
  }

  // the live stream never applies an ordinal the backfill also covers: live
  // only ever starts at or beyond the handover point
  val NoDoubleIndex: bool = or(liveCursor == 0, liveCursor >= target)
  // the backfill never runs past its target
  val BackfillWithinTarget: bool = backfillCursor <= target
  // once live, the cursor never sits below the handover point
  val CursorMonotonic: bool = or(mode != "live", liveCursor >= target)
  // reaching live implies the backfill reached the target first
  val HandoffConsistent: bool = or(mode != "live", backfillCursor == target)
  // the index holds every ordinal either source covered, exactly once
  val EntriesCoverHighest: bool = entries == maxOf(backfillCursor, liveCursor)
  val CursorsNonNegative: bool = and(
    backfillCursor >= 0,
    liveCursor >= 0,
    deferred >= 0,
    entries >= 0
  )
}
