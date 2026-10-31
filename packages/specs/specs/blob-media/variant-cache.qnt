// Blob/media service: the per-variant derivative cache and its LRU eviction.
//
// The cache holds at most two derived variants in recency order: `newest` is the
// most-recently-used key, `older` the least. A touch of the newest key is a hot
// hit; a touch of the older key promotes it; a touch of any other variant either
// fills a free slot or evicts the least-recently-used entry to hold the two-slot
// bound. `expire` is the TTL dropping the least-recently-used entry.
//
// The generator's subset has no collections, so "a cache of two" is modelled as
// two explicit slots rather than a map.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/blob-media/variant-cache.test.ts).
module blob_media_variant_cache {
  var newest: str    // most-recently-used key: "none" | "thumb" | "feed" | "full"
  var older: str     // least-recently-used key: "none" | "thumb" | "feed" | "full"
  var placed: int    // slot fillings (an insert or a replace)
  var evicted: int   // entries dropped from the cache
  var refreshed: int // hits and promotions

  // Occupancy of one slot, as a derived count (no collection state).
  def slotCount(slot: str): int = if (slot == "none") 0 else 1

  // Occupancy of the two slots.
  def occupied(first: str, second: str): int =
    slotCount(first) + slotCount(second)

  action init = all {
    newest' = "none",
    older' = "none",
    placed' = 0,
    evicted' = 0,
    refreshed' = 0
  }

  // Touch a variant: hot hit on `newest`, promotion of `older`, otherwise a new
  // insert that evicts the LRU entry when both slots are full.
  action touch = {
    nondet pick = Set("thumb", "feed", "full").oneOf()
    all {
      newest' = if (pick == newest) newest
                else if (pick == older) pick
                else pick,
      older' = if (pick == newest) older
               else if (pick == older) newest
               else newest,
      placed' = if (pick == newest or pick == older) placed else placed + 1,
      evicted' = if (pick == newest or pick == older) evicted
                 else if (older == "none") evicted
                 else evicted + 1,
      refreshed' = if (pick == newest or pick == older)
                     refreshed + 1
                   else refreshed
    }
  }

  // TTL expiry of the least-recently-used entry.
  action expire = all {
    newest' = newest,
    older' = "none",
    placed' = placed,
    evicted' = if (older == "none") evicted else evicted + 1,
    refreshed' = refreshed
  }

  action step = any { init, touch, expire }

  val NewestValid: bool = or(
    newest == "none", newest == "thumb", newest == "feed", newest == "full"
  )
  val OlderValid: bool = or(
    older == "none", older == "thumb", older == "feed", older == "full"
  )
  // The two slots never name the same variant.
  val SlotsDistinct: bool = or(older == "none", neq(newest, older))
  // An `older` slot implies an occupied `newest` slot.
  val OlderImpliesNewest: bool = or(older == "none", newest != "none")
  val CountersNonNegative: bool = and(
    placed >= 0, evicted >= 0, refreshed >= 0
  )
  // Every slot filling is either still occupied or has since been evicted: the
  // two-slot bound is exact, and a promotion/hit changes neither side.
  val PlacementAccounting: bool = placed == occupied(newest, older) + evicted
}
