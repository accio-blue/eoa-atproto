// Space host: the per-space write log and its compare-and-swap.
//
// Writes append to a single per-space log identified by its head version. A
// writer snapshots the head (`begin`), then appends with compare-and-swap. A
// competing writer (`race`) may advance the head behind its back; the stale
// append must then conflict and leave the log untouched — never merge.

module space_write_log {
  var logHead: int      // committed log head version
  var base: int      // version the pending write was based on
  var outcome: str   // "none" | "begin" | "committed" | "conflict"

  action init = all {
    logHead' = 0,
    base' = 0,
    outcome' = "none"
  }

  action begin = all {
    logHead' = logHead,
    base' = logHead,
    outcome' = "begin"
  }

  action appendOp = all {
    logHead' = if (base == logHead) logHead + 1 else logHead,
    base' = base,
    outcome' = if (base == logHead) "committed" else "conflict"
  }

  // A competing writer advances the shared head, making this writer's base
  // stale without touching the writer's own view.
  action race = {
    nondet delta = Set(1, 2).oneOf()
    all {
      logHead' = logHead + delta,
      base' = base,
      outcome' = "none"
    }
  }

  action step = any { init, begin, appendOp, race }

  // A commit advances the head by exactly one from the base it presented; a
  // merge on a stale base would break this.
  val NoMergeOnConflict: bool =
    or(outcome != "committed", base + 1 == logHead)

  // A writer's base can never run ahead of the shared log.
  val BaseNeverAhead: bool = base <= logHead

  val HeadNonNegative: bool = logHead >= 0
}
