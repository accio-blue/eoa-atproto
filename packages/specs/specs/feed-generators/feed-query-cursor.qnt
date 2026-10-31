// Feed generators: feed query pagination with an opaque cursor and dedupe.
//
// A feed generator answers `app.bsky.feed.getFeed` requests one page at a
// time. Each page carries an opaque cursor the client echoes back to request
// the next page. The generator is idempotent under replay: a page may re-serve
// records the client already saw (store lag, overlapping ranges), and those
// duplicates are dropped rather than counted as new items. The committed
// cursor is the high-watermark of *unique* records actually served, so it
// never advances past a record the client never received and never moves
// backwards.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/feed-generators/feed-query-cursor.test.ts).
module feed_generators_feed_query_cursor {
  var status: str    // "idle" | "serving" | "exhausted"
  var fetched: int   // records received from the backing store across pages
  var served: int    // unique records returned to the client
  var deduped: int   // duplicate records dropped by dedupe
  var cursor: int    // committed cursor: high-watermark of unique served records
  var pages: int     // pages served

  action init = all {
    status' = "idle",
    fetched' = 0,
    served' = 0,
    deduped' = 0,
    cursor' = 0,
    pages' = 0
  }

  action open = all {
    status' = if (status == "idle") "serving" else status,
    fetched' = fetched,
    served' = served,
    deduped' = deduped,
    cursor' = cursor,
    pages' = pages
  }

  // A page of fresh records arrives: only unique records advance the cursor.
  // `fresh == 0` means the store has nothing new, so the feed is exhausted.
  action page = {
    nondet fresh = Set(0, 1, 2, 3).oneOf()
    all {
      status' = if (status == "serving" and fresh == 0) "exhausted" else status,
      fetched' = if (status == "serving") fetched + fresh else fetched,
      served' = if (status == "serving") served + fresh else served,
      deduped' = deduped,
      cursor' = if (status == "serving") served + fresh else cursor,
      pages' = if (status == "serving") pages + 1 else pages
    }
  }

  // A page that only re-serves already-seen records: dedupe drops them, the
  // client is not double-charged, and the cursor does not move.
  action replay = {
    nondet stale = Set(1, 2).oneOf()
    all {
      status' = status,
      fetched' = if (status == "serving") fetched + stale else fetched,
      served' = served,
      deduped' = if (status == "serving") deduped + stale else deduped,
      cursor' = cursor,
      pages' = if (status == "serving") pages + 1 else pages
    }
  }

  action reset = all {
    status' = "idle",
    fetched' = fetched,
    served' = served,
    deduped' = deduped,
    cursor' = cursor,
    pages' = pages
  }

  action step = any { init, open, page, replay, reset }

  val StatusValid: bool = or(
    status == "idle",
    status == "serving",
    status == "exhausted"
  )

  // Every fetched record is accounted for exactly once: either served or
  // deduped. Dedupe is what keeps the ledger balanced across replays.
  val AccountingExact: bool = fetched == served + deduped

  // The cursor is the high-watermark of unique served records; dedupe never
  // lets it run past what the client actually received.
  val CursorTracksServed: bool = cursor == served

  val CountersNonNegative: bool = and(
    fetched >= 0,
    served >= 0,
    deduped >= 0,
    cursor >= 0,
    pages >= 0
  )
}
