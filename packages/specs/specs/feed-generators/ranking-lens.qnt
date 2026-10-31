// Feed generators: the ranking lens over public records.
//
// The generator's lens decides what a feed actually shows. Candidate records
// arrive from the indexer, are passed through a visibility gate (blocks, muted
// words, takedowns), deduped against what the feed already accepted, and then
// the lens either places a survivor into the next feed slot or suppresses it
// (diversity, recency cut-offs). The safety property is exact accounting:
// every candidate the lens considered is either blocked, deduped, still
// pending, ranked, or suppressed — exactly once — and a feed slot can only be
// filled from the pending pool.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/feed-generators/ranking-lens.test.ts).
module feed_generators_ranking_lens {
  var lens: str        // "chronological" | "discovery"
  var observed: int    // candidate records the lens considered
  var blocked: int     // candidates refused by the visibility gate
  var duplicate: int   // candidates refused by rank dedupe
  var pending: int     // visible, unique candidates awaiting placement
  var ranked: int      // candidates placed into a feed slot
  var suppressed: int  // visible, unique candidates the lens chose not to surface
  var slot: int        // next feed slot index (== ranked)

  action init = all {
    lens' = "chronological",
    observed' = 0,
    blocked' = 0,
    duplicate' = 0,
    pending' = 0,
    ranked' = 0,
    suppressed' = 0,
    slot' = 0
  }

  action chooseLens = {
    nondet choice = Set("chronological", "discovery").oneOf()
    all {
      lens' = choice,
      observed' = observed,
      blocked' = blocked,
      duplicate' = duplicate,
      pending' = pending,
      ranked' = ranked,
      suppressed' = suppressed,
      slot' = slot
    }
  }

  // One candidate arrives. It is either refused by the visibility gate
  // (blocked), a repeat of an already-accepted record (duplicate), or fresh
  // and visible, in which case it joins the pending pool.
  action observe = {
    nondet outcome = Set("public", "blocked", "repeat").oneOf()
    all {
      lens' = lens,
      observed' = observed + 1,
      blocked' = if (outcome == "blocked") blocked + 1 else blocked,
      duplicate' = if (outcome == "repeat") duplicate + 1 else duplicate,
      pending' = if (outcome == "public") pending + 1 else pending,
      ranked' = ranked,
      suppressed' = suppressed,
      slot' = slot
    }
  }

  // The lens places one pending candidate into a feed slot, or suppresses it.
  // Placement is a no-op when nothing is pending.
  action place = {
    nondet decision = Set("rank", "suppress").oneOf()
    all {
      lens' = lens,
      observed' = observed,
      blocked' = blocked,
      duplicate' = duplicate,
      pending' = if (pending > 0) pending - 1 else pending,
      ranked' = if (pending > 0 and decision == "rank") ranked + 1 else ranked,
      suppressed' = if (pending > 0 and decision == "suppress") suppressed + 1 else suppressed,
      slot' = if (pending > 0 and decision == "rank") slot + 1 else slot
    }
  }

  action step = any { init, chooseLens, observe, place }

  val LensValid: bool = or(lens == "chronological", lens == "discovery")

  // Every observed candidate is accounted for exactly once.
  val AccountingExact: bool =
    observed == blocked + duplicate + pending + ranked + suppressed

  // A record can only enter the feed from the pending pool, so the slot count
  // can never outrun what survived the gate and dedupe.
  val SlotTracksRanked: bool = slot == ranked

  val CountersNonNegative: bool = and(
    observed >= 0,
    blocked >= 0,
    duplicate >= 0,
    pending >= 0,
    ranked >= 0,
    suppressed >= 0,
    slot >= 0
  )
}
