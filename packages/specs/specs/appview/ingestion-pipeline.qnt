// AppView ingest -> projection pipeline.
//
// The AppView hosts canonical reads: canonical records arrive from the live
// firehose and are applied to the canonical index in sequence order, then
// materialised into the read projection. The pipeline is single-writer:
// exactly one canonical record is applied at a time, and projections drain
// the applied backlog. A forward gap blocks the pipeline until a backfill
// closes it; a stale or duplicate delivery is ignored.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/appview/ingestion-pipeline.test.ts).
module appview_ingestion_pipeline {
  var stage: str      // "idle" | "receiving" | "applying" | "projecting" | "blocked"
  var cursor: int     // sequence number of the last canonical apply
  var buffered: int   // received but not yet applied
  var applied: int    // records applied to the canonical index
  var projected: int  // records reflected in the read projection

  action init = all {
    stage' = "idle",
    cursor' = 0,
    buffered' = 0,
    applied' = 0,
    projected' = 0
  }

  // open the ingest stream
  action start = all {
    stage' = "receiving",
    cursor' = cursor,
    buffered' = buffered,
    applied' = applied,
    projected' = projected
  }

  // one delivery from the live stream: delta is its offset from the cursor
  //   delta == 1  -> next in order: buffer it for apply
  //   delta <= 0  -> stale/duplicate delivery: ignore
  //   delta > 1   -> forward gap: block until a backfill closes it
  action receive = {
    nondet delta = Set(1, 2, 5, 0, -1).oneOf()
    all {
      stage' = if (stage == "receiving" and delta == 1) "applying"
        else if (stage == "receiving" and delta > 1) "blocked"
        else stage,
      buffered' = if (stage == "receiving" and delta == 1) buffered + 1 else buffered,
      cursor' = cursor,
      applied' = applied,
      projected' = projected
    }
  }

  // apply exactly one buffered record, advancing the cursor by one
  action apply = all {
    stage' = if (buffered > 0) "projecting" else stage,
    buffered' = if (buffered > 0) buffered - 1 else buffered,
    applied' = if (buffered > 0) applied + 1 else applied,
    cursor' = if (buffered > 0) cursor + 1 else cursor,
    projected' = projected
  }

  // materialise the next applied record into the read projection
  action project = all {
    stage' = if (projected < applied) "receiving" else stage,
    projected' = if (projected < applied) projected + 1 else projected,
    cursor' = cursor,
    buffered' = buffered,
    applied' = applied
  }

  action step = any { init, start, receive, apply, project }

  // an apply consumes exactly one sequence number, so the number of applied
  // records can never run ahead of the canonical cursor
  val NoDoubleApply: bool = applied <= cursor
  // nothing is projected that was not first applied, and the counts stay sane
  val IndexConsistent: bool = and(
    projected <= applied,
    applied <= cursor,
    buffered >= 0
  )
  val CursorNonNegative: bool = cursor >= 0
  val StageValid: bool = or(
    stage == "idle",
    stage == "receiving",
    stage == "applying",
    stage == "projecting",
    stage == "blocked"
  )
}
