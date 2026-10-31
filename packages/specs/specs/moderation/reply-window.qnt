// Moderation service: the right of reply.
//
// The subject of an action is notified, which opens a reply window. The subject
// may submit at most one reply while the window is open; the reply is then
// published or rejected. A window can expire without a reply, and a reply can
// never exist without the notice that opened its window.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/moderation/reply-window.test.ts).

module moderation_reply_window {
  var notice: str // "none" | "sent"
  var window: str // "closed" | "open" | "expired"
  var reply: str  // "none" | "submitted" | "published" | "rejected"
  var rounds: int // replies submitted (at most one)

  action init = all {
    notice' = "none",
    window' = "closed",
    reply' = "none",
    rounds' = 0
  }

  // the subject is notified; a reply window opens once
  action notify = all {
    notice' = if (notice == "none") "sent" else notice,
    window' = if (notice == "none") "open" else window,
    reply' = reply,
    rounds' = rounds
  }

  // the subject submits one reply while the window is open
  action submit = all {
    notice' = notice,
    window' = window,
    reply' = if (window == "open" and reply == "none") "submitted" else reply,
    rounds' = if (window == "open" and reply == "none") rounds + 1 else rounds
  }

  // the window closes without a reply
  action expire = all {
    notice' = notice,
    window' = if (window == "open") "expired" else window,
    reply' = reply,
    rounds' = rounds
  }

  // a submitted reply is published
  action publish = all {
    notice' = notice,
    window' = window,
    reply' = if (reply == "submitted") "published" else reply,
    rounds' = rounds
  }

  // a submitted reply is rejected
  action discard = all {
    notice' = notice,
    window' = window,
    reply' = if (reply == "submitted") "rejected" else reply,
    rounds' = rounds
  }

  action step = any { init, notify, submit, expire, publish, discard }

  val NoticeValid: bool = or(notice == "none", notice == "sent")
  val WindowValid: bool = or(
    window == "closed",
    window == "open",
    window == "expired"
  )
  val ReplyValid: bool = or(
    reply == "none",
    reply == "submitted",
    reply == "published",
    reply == "rejected"
  )
  // an open or expired window requires the notice that opened it
  val WindowNeedsNotice: bool =
    or(window == "closed", notice == "sent")
  // a reply is only ever created through a notified window
  val ReplyNeedsNotice: bool =
    or(reply == "none", notice == "sent")
  // at most one reply is ever accepted
  val RoundsBound: bool = and(rounds >= 0, rounds <= 1)
  // a reply existing implies exactly one round was counted
  val RoundsTracksReply: bool =
    or(reply == "none", rounds == 1)
}
