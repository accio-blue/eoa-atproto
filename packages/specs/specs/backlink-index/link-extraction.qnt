// Backlink index (Constellation): link extraction from a record + index update.
//
// A backlink index keys REFERENCES, not content: it maps a target AT-URI to
// the records that point at it. The live side subscribes to the relay and, for
// every record observed, extracts the strong references the record carries and
// writes one index entry per reference under the referenced target. A single
// ingest cursor advances once per observed record, so the cursor is exactly the
// number of records the extractor has consumed.
//
// One `scenario` selector encodes the record the stream delivers (0 -> no
// references, 1 -> one reference, 2 -> two references, 3 -> one reference to a
// different target). Extraction and indexing are derived from the same pure
// defs the invariants use.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/backlink-index/link-extraction.test.ts).
module backlink_link_extraction {
  import base.* from "../../shared/base"

  var mode: str        // "idle" | "live"
  var cursor: int      // ingest sequence: one advance per observed record
  var observed: int    // records consumed off the stream
  var extracted: int   // references pulled out of those records
  var indexed: int     // references written to the target-keyed index
  var lastTarget: str  // target of the last indexed reference ("none" = none)
  var lastSource: str  // record that carried the last indexed reference

  // Sample targets and sources. A target is the referenced subject; a source is
  // the record that references it (a like, a comment, a claim).
  def targetA: str =
    "at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a"
  def targetB: str =
    "at://did:web:example.com/app.bsky.feed.post/3k2la9x8w1"
  def sourceLike: str =
    "at://did:plc:genesis/app.bsky.feed.like/3jzsm4zqb2s2b"
  def sourceComment: str =
    "at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2c"

  // the index only ever holds references (AT-URIs), never content
  def isReference(value: str): bool =
    or(
      value == targetA,
      or(value == targetB, or(value == sourceLike, value == sourceComment))
    )

  // how many references the record carries
  def refsFor(scenario: int): int =
    if (scenario == 2) 2 else if (scenario == 0) 0 else 1

  // the target of the record's last reference (none when it carries none)
  def targetFor(scenario: int): str =
    if (scenario == 0) none
    else if (scenario == 1) targetA
    else targetB

  // the record that carried it
  def sourceFor(scenario: int): str =
    if (scenario == 0) none
    else if (or(scenario == 1, scenario == 2)) sourceLike
    else sourceComment

  action init = all {
    mode' = "idle",
    cursor' = 0,
    observed' = 0,
    extracted' = 0,
    indexed' = 0,
    lastTarget' = none,
    lastSource' = none
  }

  action start = all {
    mode' = "live",
    cursor' = cursor,
    observed' = observed,
    extracted' = extracted,
    indexed' = indexed,
    lastTarget' = lastTarget,
    lastSource' = lastSource
  }

  // one record arrives: advance the ingest cursor, extract its references and
  // write one index entry per reference under the referenced target
  action observe = {
    nondet scenario = Set(0, 1, 2, 3).oneOf()
    all {
      mode' = mode,
      cursor' = if (mode == "live") cursor + 1 else cursor,
      observed' = if (mode == "live") observed + 1 else observed,
      extracted' = if (mode == "live")
        extracted + refsFor(scenario)
        else extracted,
      indexed' = if (mode == "live") indexed + refsFor(scenario) else indexed,
      lastTarget' = if (mode == "live" and refsFor(scenario) > 0)
        targetFor(scenario)
        else lastTarget,
      lastSource' = if (mode == "live" and refsFor(scenario) > 0)
        sourceFor(scenario)
        else lastSource
    }
  }

  action pause = all {
    mode' = "idle",
    cursor' = cursor,
    observed' = observed,
    extracted' = extracted,
    indexed' = indexed,
    lastTarget' = lastTarget,
    lastSource' = lastSource
  }

  action step = any { init, start, observe, pause }

  val ModeValid: bool = or(mode == "idle", mode == "live")
  val CursorNonNegative: bool = cursor >= 0
  val CountsNonNegative: bool = and(
    observed >= 0,
    extracted >= 0,
    indexed >= 0
  )
  // the ingest cursor counts exactly the records the extractor consumed
  val IngestExact: bool = cursor == observed
  // this machine writes one index entry per extracted reference; dedupe across
  // sources is a separate machine
  val IndexExact: bool = indexed == extracted
  // an index key is always a reference (or absent), never content
  val LastTargetIsReference: bool =
    or(isNone(lastTarget), isReference(lastTarget))
  val LastSourceIsReference: bool =
    or(isNone(lastSource), isReference(lastSource))
}
