// Relay upstream subscription: one PDS, one repo firehose, one cursor.
//
// A relay subscribes to a PDS's `com.atproto.sync.subscribeRepos` stream and
// commits a cursor as records arrive. In-order records advance the cursor;
// stale or duplicate records are ignored; a forward gap puts the subscription
// into backfill, which refetches from the cursor before returning to live.
// The spec is the source of truth for the cursor discipline.
module relay_subscription_cursor {
  var status: str     // "idle" | "subscribing" | "live" | "backfilling" | "backoff"
  var cursor: int     // last committed upstream sequence number
  var resume: int     // next sequence requested on (re)subscribe / backfill
  var attempts: int   // consecutive connection failures

  action init = all {
    status' = "idle",
    cursor' = 0,
    resume' = 1,
    attempts' = 0
  }

  action subscribe = all {
    status' = "subscribing",
    cursor' = cursor,
    resume' = resume,
    attempts' = attempts
  }

  action open = all {
    status' = "live",
    cursor' = cursor,
    resume' = resume,
    attempts' = 0
  }

  // a record delta arrives while live:
  //   delta == 1 -> in order: commit it and advance both cursors
  //   delta <= 0 -> stale or duplicate: ignore it
  //   delta > 1  -> forward gap: backfill from the cursor before resuming
  action commit = {
    nondet delta = Set(1, 2, 5, 20, -1, 0).oneOf()
    all {
      status' = if (status == "live" and delta > 1) "backfilling" else status,
      cursor' = if (status == "live" and delta == 1) cursor + 1 else cursor,
      resume' = if (status == "live" and delta == 1) cursor + 2 else resume,
      attempts' = attempts
    }
  }

  // backfill refetches the gap; when it drains, the subscription goes live
  // without the committed cursor jumping past the unrefetched records
  action backfill = all {
    status' = if (status == "backfilling") "live" else status,
    cursor' = cursor,
    resume' = resume,
    attempts' = attempts
  }

  action degrade = all {
    status' = "backoff",
    cursor' = cursor,
    resume' = resume,
    attempts' = attempts + 1
  }

  action retry = all {
    status' = "subscribing",
    cursor' = cursor,
    resume' = resume,
    attempts' = attempts
  }

  action step = any { init, subscribe, open, commit, backfill, degrade, retry }

  val StatusValid: bool = or(
    status == "idle",
    status == "subscribing",
    status == "live",
    status == "backfilling",
    status == "backoff"
  )
  val CursorNonNegative: bool = cursor >= 0
  val AttemptsNonNegative: bool = attempts >= 0
  // `resume` is exactly the first uncommitted sequence: the policy never
  // advances the request cursor past an unseen record, so a gap is never
  // silently skipped.
  val NoGapSkipped: bool = resume == cursor + 1
}
