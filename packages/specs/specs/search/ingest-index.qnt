// Search service: ingest -> index with an ordinal cursor.
//
// The search index ingests records from the live firehose in sequence order.
// A forward gap blocks ingestion until it closes; a stale or duplicate
// delivery is ignored. Indexing one buffered record advances the cursor by
// exactly one, and a delete tombstones an indexed document so it leaves the
// queryable set. Every document the index ever held (still present or
// tombstoned) accounts for one cursor advance.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/search/ingest-index.test.ts).
module search_ingest_index {
  var phase: str      // "idle" | "streaming" | "blocked"
  var cursor: int     // sequence of the last indexed ingest
  var buffer: int     // received but not yet indexed
  var docs: int       // documents currently indexed
  var tombstones: int // documents deleted from the index

  action init = all {
    phase' = "idle",
    cursor' = 0,
    buffer' = 0,
    docs' = 0,
    tombstones' = 0
  }

  // open the ingest stream
  action startStream = all {
    phase' = "streaming",
    cursor' = cursor,
    buffer' = buffer,
    docs' = docs,
    tombstones' = tombstones
  }

  // one delivery: delta is its offset from the cursor
  //   delta == 1  -> next in order: buffer it
  //   delta > 1   -> forward gap: block until it closes
  //   delta <= 0  -> stale/duplicate: ignore
  action receive = {
    nondet delta = Set(1, 2, 5, 0, -1).oneOf()
    all {
      phase' = if (phase == "streaming" and delta == 1) "streaming"
        else if (phase == "streaming" and delta > 1) "blocked"
        else phase,
      cursor' = cursor,
      buffer' = if (phase == "streaming" and delta == 1) buffer + 1 else buffer,
      docs' = docs,
      tombstones' = tombstones
    }
  }

  // index exactly one buffered record, advancing the cursor by one
  action indexRecord = all {
    phase' = phase,
    cursor' = if (buffer > 0) cursor + 1 else cursor,
    buffer' = if (buffer > 0) buffer - 1 else buffer,
    docs' = if (buffer > 0) docs + 1 else docs,
    tombstones' = tombstones
  }

  // delete an indexed document: it leaves the queryable set as a tombstone
  action deleteDoc = all {
    phase' = phase,
    cursor' = cursor,
    buffer' = buffer,
    docs' = if (docs > 0) docs - 1 else docs,
    tombstones' = if (docs > 0) tombstones + 1 else tombstones
  }

  action step = any { init, startStream, receive, indexRecord, deleteDoc }

  val PhaseValid: bool = or(
    phase == "idle",
    phase == "streaming",
    phase == "blocked"
  )
  val CursorNonNegative: bool = cursor >= 0
  val BufferNonNegative: bool = buffer >= 0
  // every indexed or tombstoned document consumed exactly one cursor advance
  val IndexedAssetsMatchCursor: bool = docs + tombstones == cursor
  // tombstones only ever account for documents that were indexed first
  val TombstonesNonNegative: bool = tombstones >= 0
}
