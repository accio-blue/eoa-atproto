// Jetstream variant: the relay firehose projected through a collection filter.
//
// Jetstream is a JSON view of the relay firehose filtered by collection. Every
// record observed on the wire advances the accounting, but only records whose
// collection matches the filter are emitted. The safety property is exact
// accounting: every observed record is either emitted or dropped, never both
// and never neither.
module relay_jetstream_filter {
  var status: str   // "idle" | "streaming" | "paused"
  var seen: int     // records observed on the wire
  var matched: int  // records that passed the collection filter
  var dropped: int  // records that were filtered out

  action init = all {
    status' = "idle",
    seen' = 0,
    matched' = 0,
    dropped' = 0
  }

  action start = all {
    status' = "streaming",
    seen' = seen,
    matched' = matched,
    dropped' = dropped
  }

  // one record arrives; only the filter's collection is emitted
  action record = {
    nondet collection = Set("app.bsky.feed.post", "app.bsky.graph.follow", "app.bsky.actor.profile", "com.atproto.label").oneOf()
    all {
      status' = status,
      seen' = if (status == "streaming") seen + 1 else seen,
      matched' = if (status == "streaming" and collection == "app.bsky.feed.post") matched + 1 else matched,
      dropped' = if (status == "streaming" and collection != "app.bsky.feed.post") dropped + 1 else dropped
    }
  }

  action pause = all {
    status' = if (status == "streaming") "paused" else status,
    seen' = seen,
    matched' = matched,
    dropped' = dropped
  }

  action resume = all {
    status' = if (status == "paused") "streaming" else status,
    seen' = seen,
    matched' = matched,
    dropped' = dropped
  }

  action stop = all {
    status' = "idle",
    seen' = seen,
    matched' = matched,
    dropped' = dropped
  }

  action step = any { init, start, record, pause, resume, stop }

  val StatusValid: bool = or(
    status == "idle",
    status == "streaming",
    status == "paused"
  )
  val CountsNonNegative: bool = and(seen >= 0, matched >= 0, dropped >= 0)
  // every observed record is accounted for exactly once
  val AccountingExact: bool = seen == matched + dropped
}
