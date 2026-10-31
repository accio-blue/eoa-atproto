// Backlink index (Constellation): the target-keyed index update + dedupe.
//
// The index is keyed by the referenced target AT-URI, and its value is the set
// of (target, source) reference pairs. A reference is offered to the index once
// per observation; an offer whose (target, source) pair is already present is a
// duplicate and must NOT grow the index. A reorg or delete retracts an existing
// pair, and re-observing it afterwards is a fresh offer again.
//
// One `scenario` selector encodes the offered reference: 0 -> a fresh pair,
// 1 -> the same pair again (duplicate), 2 -> the same source pointing at a
// different target (fresh pair), 3 -> a different source pointing at the same
// target (fresh pair). Novelty is derived from the same pure def the invariant
// uses.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/backlink-index/target-index.test.ts).
module backlink_target_index {
  import base.* from "../../shared/base"

  var entries: int     // live distinct (target, source) entries in the index
  var observed: int    // references offered to the index
  var duplicates: int  // offers that matched an entry already present
  var removed: int     // entries retracted by a reorg or delete
  var lastTarget: str  // target key of the last offer
  var lastSource: str  // source record of the last offer
  var lastDup: bool    // the last offer was a duplicate

  def targetA: str =
    "at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a"
  def targetB: str =
    "at://did:web:example.com/app.bsky.feed.post/3k2la9x8w1"
  def sourceLike: str =
    "at://did:plc:genesis/app.bsky.feed.like/3jzsm4zqb2s2b"
  def sourceComment: str =
    "at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2c"

  def isReference(value: str): bool =
    or(
      value == targetA,
      or(value == targetB, or(value == sourceLike, value == sourceComment))
    )

  // a fresh (target, source) pair, versus the duplicate pair already indexed
  def novelFor(scenario: int): bool =
    or(scenario == 0, or(scenario == 2, scenario == 3))
  def dupFor(scenario: int): bool = scenario == 1

  def targetFor(scenario: int): str =
    if (or(scenario == 0, or(scenario == 1, scenario == 3))) targetA
    else targetB
  def sourceFor(scenario: int): str =
    if (or(scenario == 0, or(scenario == 1, scenario == 2))) sourceLike
    else sourceComment

  action init = all {
    entries' = 0,
    observed' = 0,
    duplicates' = 0,
    removed' = 0,
    lastTarget' = none,
    lastSource' = none,
    lastDup' = false
  }

  // one reference offered to the index: a fresh pair adds an entry, a duplicate
  // pair is recorded but never grows the index
  action offer = {
    nondet scenario = Set(0, 1, 2, 3).oneOf()
    all {
      entries' = if (novelFor(scenario)) entries + 1 else entries,
      observed' = observed + 1,
      duplicates' = if (dupFor(scenario)) duplicates + 1 else duplicates,
      removed' = removed,
      lastTarget' = targetFor(scenario),
      lastSource' = sourceFor(scenario),
      lastDup' = dupFor(scenario)
    }
  }

  // a reorg or delete retracts one existing entry; the index never goes below
  // zero, and a retraction of an empty index is a no-op
  action retract = all {
    entries' = if (entries > 0) entries - 1 else entries,
    observed' = observed,
    duplicates' = duplicates,
    removed' = if (entries > 0) removed + 1 else removed,
    lastTarget' = lastTarget,
    lastSource' = lastSource,
    lastDup' = false
  }

  action step = any { init, offer, retract }

  val EntriesNonNegative: bool = entries >= 0
  val ObservedNonNegative: bool = observed >= 0
  val DuplicatesNonNegative: bool = duplicates >= 0
  val RemovedNonNegative: bool = removed >= 0
  // every offered reference is exactly one of: a live entry, a duplicate, or a
  // retracted entry -- dedupe never double-counts and never loses an offer
  val IndexAccountingExact: bool =
    observed == entries + removed + duplicates
  // an index key is always a reference (or absent), never content
  val LastTargetIsReference: bool =
    or(isNone(lastTarget), isReference(lastTarget))
  val LastSourceIsReference: bool =
    or(isNone(lastSource), isReference(lastSource))
  // a duplicate always names the (target, source) pair it matched
  val DuplicateNamesPair: bool =
    or(
      not(lastDup),
      and(not(isNone(lastTarget)), not(isNone(lastSource)))
    )
}
