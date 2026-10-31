// Relay aggregation + backfill: the relay's own output firehose.
//
// Upstream subscriptions feed a single ordered firehose. The relay advances
// its own sequence as it appends, records each consumer's durable checkpoint
// (ack), and replays from storage when a consumer falls behind. The safety
// property is that the checkpoint never runs ahead of what was appended.
module relay_aggregation {
  var status: str          // "cold" | "live" | "backfilling"
  var feedSeq: int         // relay firehose sequence: last appended record
  var ackSeq: int          // consumer's durable checkpoint
  var backfillTarget: int  // feedSeq snapshot a backfill must catch up to

  action init = all {
    status' = "cold",
    feedSeq' = 0,
    ackSeq' = 0,
    backfillTarget' = 0
  }

  action goLive = all {
    status' = "live",
    feedSeq' = feedSeq,
    ackSeq' = ackSeq,
    backfillTarget' = backfillTarget
  }

  // append a batch of upstream records to the firehose (live only)
  action appendBatch = {
    nondet n = Set(1, 2, 3).oneOf()
    all {
      status' = status,
      feedSeq' = if (status == "live") feedSeq + n else feedSeq,
      ackSeq' = ackSeq,
      backfillTarget' = backfillTarget
    }
  }

  // the consumer acknowledges up to `n` records; a checkpoint is clamped to
  // what the relay has actually appended, so it can never run ahead
  action ack = {
    nondet n = Set(1, 2, 5).oneOf()
    all {
      status' = status,
      feedSeq' = feedSeq,
      ackSeq' = if (ackSeq + n > feedSeq) feedSeq else ackSeq + n,
      backfillTarget' = backfillTarget
    }
  }

  // a consumer falls behind and asks to replay from `from`; the checkpoint
  // rewinds (clamped) and the target is the current head
  action startBackfill = {
    nondet from = Set(0, 1, 2, 5).oneOf()
    all {
      status' = "backfilling",
      feedSeq' = feedSeq,
      ackSeq' = if (from > feedSeq) feedSeq else from,
      backfillTarget' = feedSeq
    }
  }

  // replay advances the checkpoint toward the target; caught up -> live
  action backfillAck = {
    nondet n = Set(1, 2, 3).oneOf()
    all {
      status' = if (status == "backfilling" and ackSeq + n >= backfillTarget) "live" else status,
      feedSeq' = feedSeq,
      ackSeq' = if (ackSeq + n > backfillTarget) backfillTarget else ackSeq + n,
      backfillTarget' = backfillTarget
    }
  }

  action step = any { init, goLive, appendBatch, ack, startBackfill, backfillAck }

  val StatusValid: bool = or(
    status == "cold",
    status == "live",
    status == "backfilling"
  )
  val FeedNonNegative: bool = feedSeq >= 0
  // the durable checkpoint never runs ahead of the appended firehose
  val AckNeverAhead: bool = ackSeq <= feedSeq
  // a backfill target is always within the appended firehose
  val BackfillTargetWithinFeed: bool = backfillTarget <= feedSeq
}
