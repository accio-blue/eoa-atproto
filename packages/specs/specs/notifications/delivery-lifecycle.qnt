// Notifications service: the per-notification delivery / read-state lifecycle.
//
// A notification is created queued, then delivered to its recipient over the
// push channel; a delivery attempt may fail and be retried. Only a delivered
// notification counts as unread, and reading it clears the unread flag. A
// notification whose subject disappears before it is read is withdrawn instead
// of delivered. The unread count and the push flag are derived from the
// lifecycle, never staged independently, so state can never claim a delivery
// that did not happen.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/notifications/delivery-lifecycle.test.ts).

module notifications_delivery_lifecycle {
  var stage: str    // "created" | "delivered" | "failed" | "read" | "withdrawn"
  var attempts: int // push delivery attempts made
  var unread: int   // 1 while delivered and unread; 0 otherwise
  var pushed: bool  // a push was handed to the recipient's channel

  // A delivery attempt is allowed from the queued or a failed state.
  def deliverable(value: str): bool =
    or(value == "created", value == "failed")

  action init = all {
    stage' = "created",
    attempts' = 0,
    unread' = 0,
    pushed' = false
  }

  // One push attempt: a successful attempt delivers (and sets unread); a failed
  // one leaves the notification failed and retryable. Attempting an already
  // resolved notification is a no-op.
  action deliver = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = if (deliverable(stage) and ok) "delivered"
               else if (deliverable(stage) and not(ok)) "failed"
               else stage,
      attempts' = if (deliverable(stage)) attempts + 1 else attempts,
      unread' = if (deliverable(stage) and ok) 1 else unread,
      pushed' = if (deliverable(stage) and ok) true else pushed
    }
  }

  // Reading a delivered notification clears its unread flag; reading anything
  // else is a no-op.
  action read = all {
    stage' = if (stage == "delivered") "read" else stage,
    attempts' = attempts,
    unread' = if (stage == "delivered") 0 else unread,
    pushed' = pushed
  }

  // The subject disappears before the notification is read: the notification is
  // withdrawn and stops counting as unread. A read notification stays read.
  action withdraw = all {
    stage' = if (stage == "read") stage else "withdrawn",
    attempts' = attempts,
    unread' = if (stage == "read") unread else 0,
    pushed' = pushed
  }

  action step = any { init, deliver, read, withdraw }

  val StageValid: bool = or(
    stage == "created",
    stage == "delivered",
    stage == "failed",
    stage == "read",
    stage == "withdrawn"
  )

  // The unread flag is a 0/1 count, and it is only ever set by a delivery.
  val UnreadBound: bool = and(unread >= 0, unread <= 1)
  val UnreadOnlyWhenDelivered: bool = or(unread == 0, stage == "delivered")

  // A push can only exist after at least one delivery attempt.
  val PushedImpliesAttempt: bool = or(not(pushed), attempts >= 1)

  // A read notification is cleared, and withdrawal never resurrects one.
  val ReadStaysCleared: bool = or(stage != "read", unread == 0)

  val AttemptsNonNegative: bool = attempts >= 0
}
