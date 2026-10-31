// Search service: delete tombstones vs stale re-ingest.
//
// A delete removes a document from the index. Because the ingest stream can
// redeliver older writes out of order, a stale re-ingest must never resurrect
// a deleted document; only a strictly newer revision re-indexes it. A query
// reflects exactly what the index currently holds.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/search/tombstone-index.test.ts).
module search_tombstone_index {
  var entry: str      // "none" | "indexed" | "deleted"
  var revision: int   // highest revision seen for the record
  var requested: bool // a query is pending
  var decision: str   // "none" | "present" | "absent"

  action init = all {
    entry' = "none",
    revision' = 0,
    requested' = false,
    decision' = "none"
  }

  // one ingest delivery: a strictly newer revision indexes (or re-indexes) the
  // record; a stale revision (already seen) is ignored
  action ingest = {
    nondet version = Set(1, 2, 3).oneOf()
    all {
      entry' = if (version > revision) "indexed" else entry,
      revision' = if (version > revision) version else revision,
      requested' = false,
      decision' = "none"
    }
  }

  // delete the document: it becomes a tombstone and leaves the queryable set
  action deleteDoc = all {
    entry' = if (entry == "indexed") "deleted" else entry,
    revision' = revision,
    requested' = false,
    decision' = "none"
  }

  action runQuery = all {
    entry' = entry,
    revision' = revision,
    requested' = true,
    decision' = if (entry == "indexed") "present" else "absent"
  }

  action step = any { init, ingest, deleteDoc, runQuery }

  val EntryValid: bool = or(
    entry == "none",
    entry == "indexed",
    entry == "deleted"
  )
  val DecisionValid: bool = or(
    decision == "none",
    decision == "present",
    decision == "absent"
  )
  // only an indexed entry is ever present in query results
  val DeletedNeverPresent: bool = or(decision != "present", entry == "indexed")
  // a decision is only ever produced by running a query
  val NoDecisionWithoutQuery: bool = or(decision == "none", requested)
  val RevisionNonNegative: bool = revision >= 0
}
