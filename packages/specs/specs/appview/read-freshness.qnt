// AppView read / index freshness.
//
// Reads are served from a projection snapshot that lags the canonical index:
// the index advances as records apply, the projection catches up in batches,
// and a read may only be served from a snapshot the projection has already
// materialised. "fresh" means the projection has caught up to the index.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/appview/read-freshness.test.ts).
module appview_read_freshness {
  var indexVersion: int      // canonical index version
  var projectionVersion: int // read projection version (lags the index)
  var servedVersion: int     // snapshot the last read was served from
  var state: str             // "fresh" | "lagging"

  action init = all {
    indexVersion' = 0,
    projectionVersion' = 0,
    servedVersion' = 0,
    state' = "fresh"
  }

  // canonical records apply: the index moves ahead of the projection
  action advanceIndex = {
    nondet step = Set(1, 2).oneOf()
    all {
      indexVersion' = indexVersion + step,
      projectionVersion' = projectionVersion,
      servedVersion' = servedVersion,
      state' = if (projectionVersion < indexVersion + step) "lagging" else "fresh"
    }
  }

  // the projection catches up toward the index, never overshooting it
  action refreshProjection = {
    nondet step = Set(1, 2).oneOf()
    all {
      projectionVersion' = if (projectionVersion + step >= indexVersion)
        indexVersion
        else projectionVersion + step,
      indexVersion' = indexVersion,
      servedVersion' = servedVersion,
      state' = if (projectionVersion + step >= indexVersion) "fresh" else "lagging"
    }
  }

  // a read is served from a projection snapshot; a snapshot the projection has
  // not materialised is refused, leaving the last served version in place
  action read = {
    nondet snapshot = Set(0, 1, 2, 3, 5).oneOf()
    all {
      servedVersion' = if (snapshot <= projectionVersion)
        snapshot
        else servedVersion,
      indexVersion' = indexVersion,
      projectionVersion' = projectionVersion,
      state' = state
    }
  }

  action step = any { init, advanceIndex, refreshProjection, read }

  // the projection never runs ahead of the index
  val IndexConsistent: bool = projectionVersion <= indexVersion
  // a read is never served from a snapshot the projection lacks
  val NoReadAheadOfProjection: bool = servedVersion <= projectionVersion
  val FreshnessStateValid: bool = or(state == "fresh", state == "lagging")
  // "fresh" means the projection has caught up exactly
  val FreshnessBound: bool = or(state != "fresh", projectionVersion == indexVersion)
}
