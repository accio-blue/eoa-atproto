// Blob/media service: the transform + thumbnail pipeline over the derived
// variant cache.
//
// A media request names a derivative variant. The pipeline answers it from the
// cache when the requested variant is the warm cached one (a hit); otherwise it
// derives the variant from the origin blob, warms the cache and serves it (a
// miss). A TTL eviction empties the cache. The raw upload lifecycle belongs to
// the PDS (`specs/pds/blob-upload.qnt`) and is intentionally not repeated here.
//
// The generator's subset has no action guards, so every action only takes
// effect in its own phase via `if (phase == ...) new else current`.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/blob-media/transform-pipeline.test.ts).
module blob_media_transform_pipeline {
  var phase: str    // "idle" | "deriving" | "serving"
  var wanted: str   // requested derivative: "none" | "thumb" | "feed" | "full"
  var cached: str   // the warm variant key: "none" | "thumb" | "feed" | "full"
  var cache: str    // "cold" | "warm"
  var derived: int  // derivatives computed from the origin blob
  var hits: int     // requests answered from the warm cache
  var served: int   // responses produced (a hit or a fresh derivation)

  def isWarm(look: str): bool = look == "warm"

  // A warm cache answers only the exact variant it holds.
  def cacheHit(warm: bool, asked: str, held: str): bool =
    and(warm, asked == held)

  action init = all {
    phase' = "idle",
    wanted' = "none",
    cached' = "none",
    cache' = "cold",
    derived' = 0,
    hits' = 0,
    served' = 0
  }

  // Accept a media request for one variant. The cache decides hit vs miss: only
  // a warm cache holding exactly the requested variant serves without deriving.
  action request = {
    nondet pick = Set("thumb", "feed", "full").oneOf()
    all {
      phase' = if (phase == "idle") (
        if (cacheHit(isWarm(cache), pick, cached)) "serving" else "deriving"
      ) else phase,
      wanted' = if (phase == "idle") pick else wanted,
      cached' = cached,
      cache' = cache,
      derived' = derived,
      hits' = if (phase == "idle" and cacheHit(isWarm(cache), pick, cached))
                hits + 1
              else hits,
      served' = if (phase == "idle" and cacheHit(isWarm(cache), pick, cached))
                  served + 1
                else served
    }
  }

  // Derive the requested variant from the origin blob, warm the cache on it and
  // serve the response.
  action derive = all {
    phase' = if (phase == "deriving") "serving" else phase,
    wanted' = wanted,
    cached' = if (phase == "deriving") wanted else cached,
    cache' = if (phase == "deriving") "warm" else cache,
    derived' = if (phase == "deriving") derived + 1 else derived,
    hits' = hits,
    served' = if (phase == "deriving") served + 1 else served
  }

  // Finish the in-flight response and return to idle.
  action settle = all {
    phase' = if (phase == "serving") "idle" else phase,
    wanted' = wanted,
    cached' = cached,
    cache' = cache,
    derived' = derived,
    hits' = hits,
    served' = served
  }

  // TTL eviction: the cached variant expires and the cache goes cold.
  action evict = all {
    phase' = phase,
    wanted' = wanted,
    cached' = "none",
    cache' = "cold",
    derived' = derived,
    hits' = hits,
    served' = served
  }

  action step = any { init, request, derive, settle, evict }

  val PhaseValid: bool = or(
    phase == "idle", phase == "deriving", phase == "serving"
  )
  val WantedValid: bool = or(
    wanted == "none", wanted == "thumb", wanted == "feed", wanted == "full"
  )
  val CachedValid: bool = or(
    cached == "none", cached == "thumb", cached == "feed", cached == "full"
  )
  val CacheValid: bool = or(cache == "cold", cache == "warm")
  val CountersNonNegative: bool = and(derived >= 0, hits >= 0, served >= 0)
  // Every response is either a cache hit or a fresh derivation — never both and
  // never neither.
  val ServedBacked: bool = served == hits + derived
  // A warm cache always names a variant that was actually derived.
  val WarmImpliesDerived: bool = or(
    cache != "warm", and(derived > 0, cached != "none")
  )
}
