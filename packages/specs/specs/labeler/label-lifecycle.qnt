// Labeler: the lifecycle of one label on one subject, plus its stream position.
//
// A labeler issues a label (`com.atproto.label.defs#label`) over a subject and
// publishes it on its own `com.atproto.label.subscribeLabels` stream. The label
// stops applying when a negation tombstone (`neg=true`) supersedes it, when the
// labeler retracts it, or when its `exp` passes. The `active` flag is a VIEW of
// the lifecycle - it is exactly the pure projection of `status` and `neg`, never
// staged independently - while `published`/`cursor` are the labeler's stream
// sequence and a subscriber's committed cursor (the subscription side of the
// labeler). The spec is the source of truth for that projection and the stream
// discipline.

module labeler_label_lifecycle {
  var status: str     // "pending" | "issued" | "negated" | "retracted" | "expired"
  var neg: bool       // the latest wire label is a negation (neg=true tombstone)
  var active: bool    // derived view: the label currently applies
  var published: int  // last sequence published on the labeler's stream
  var cursor: int     // subscriber's committed subscribeLabels cursor

  // The active view is a pure projection of the lifecycle: a label applies only
  // while it is issued and carries no negation.
  def isLive(value: str, negated: bool): bool =
    and(value == "issued", not(negated))

  action init = all {
    status' = "pending",
    neg' = false,
    active' = false,
    published' = 0,
    cursor' = 0
  }

  // Issue the label: the labeler emits a positive label at the next sequence.
  action emit = all {
    status' = if (status == "pending") "issued" else status,
    neg' = if (status == "pending") false else neg,
    active' = if (status == "pending") true else active,
    published' = if (status == "pending") published + 1 else published,
    cursor' = cursor
  }

  // Negate the label: a `neg=true` tombstone is emitted that overwrites it.
  action negate = all {
    status' = if (status == "issued") "negated" else status,
    neg' = if (status == "issued") true else neg,
    active' = if (status == "issued") false else active,
    published' = if (status == "issued") published + 1 else published,
    cursor' = cursor
  }

  // Retract the label administratively: a tombstone is emitted and the label
  // stops applying. Distinct from expiry - a retraction IS a wire event.
  action retract = all {
    status' = if (status == "issued") "retracted" else status,
    neg' = if (status == "issued") true else neg,
    active' = if (status == "issued") false else active,
    published' = if (status == "issued") published + 1 else published,
    cursor' = cursor
  }

  // Expire the label: its `exp` passes; nothing is emitted (no wire event).
  action expire = all {
    status' = if (status == "issued") "expired" else status,
    neg' = neg,
    active' = if (status == "issued") false else active,
    published' = published,
    cursor' = cursor
  }

  // The subscriber acknowledges up to `n` labels; the committed cursor is
  // clamped to what the labeler actually published, so it never runs ahead.
  action ack = {
    nondet n = Set(1, 2, 5).oneOf()
    all {
      status' = status,
      neg' = neg,
      active' = active,
      published' = published,
      cursor' = if (cursor + n > published) published else cursor + n
    }
  }

  action step = any { init, emit, negate, retract, expire, ack }

  val StatusValid: bool = or(
    status == "pending",
    status == "issued",
    status == "negated",
    status == "retracted",
    status == "expired"
  )

  // The label is a view: the active flag is exactly the pure projection of the
  // lifecycle, never staged independently.
  val ActiveIsView: bool = active == isLive(status, neg)

  // A negation is only ever recorded for a superseded label.
  val NegOnlyWhenSuperseded: bool = or(
    not(neg),
    or(status == "negated", status == "retracted")
  )

  // An expired label is never a tombstone.
  val ExpiredNotTombstone: bool = or(status != "expired", not(neg))

  // The subscriber's cursor never runs ahead of the published stream.
  val CursorNeverAhead: bool = cursor <= published

  val CursorNonNegative: bool = cursor >= 0
  val PublishedNonNegative: bool = published >= 0
}
