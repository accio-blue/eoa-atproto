// The outbound queue — what a relay *is*, and the properties a sender depends on.
//
// Our MX refuses to `250` a message it has not spooled (`nx4h`), and our sink is
// idempotent because a message's record key is its own digest (`y4n6`). A queue is
// those two properties stretched over time and failure: the spool is durable, the
// retry schedule is obeyed, a delivery happens once, and a permanent failure
// produces something a human can read.
//
// The schedule is comail's, from their operator runbook — 1, 5, 15, 30 and 60
// minutes, five attempts, then a DSN. Those are a reference rather than a guess,
// and they live here so changing them is a change to a *machine* rather than to a
// constant somebody edited at 3am.
//
// Guards live in the assignment RHS because the generator supports no action
// preconditions.
module mail_outbound_queue {
  var state: str // "spooled" | "delivered" | "bounced"
  var attempts: int // delivery attempts made
  var now: int // minutes since the message was spooled
  var dueAt: int // the minute the next attempt is allowed
  var lastDueAt: int // the `dueAt` in force when the last attempt was made
  var lastAttemptAt: int // the minute of the last attempt
  var everDelivered: bool // the monotone witness: a delivery is final
  var dsn: bool // a bounce report was produced
  var lastCode: int // the recipient MX's answer (0/250/451/550)

  def sendable: bool = state == "spooled"
  def spent: bool = attempts >= 5
  def due: bool = now >= dueAt
  def canAttempt: bool = and(sendable, due)

  // The backoff, in minutes. comail's numbers, and the reason a schedule is in a
  // spec at all: "1, 5, 15, 30, 60" is a policy, not an implementation detail.
  def backoffFor(n: int): int =
    if (n <= 1) 1
    else if (n == 2) 5
    else if (n == 3) 15
    else if (n == 4) 30
    else 60

  action init = all {
    state' = "spooled",
    attempts' = 0,
    now' = 0,
    dueAt' = 0,
    lastDueAt' = 0,
    lastAttemptAt' = 0,
    everDelivered' = false,
    dsn' = false,
    lastCode' = 0,
  }

  // Time passes. A queue that never wakes is a queue that never retries.
  action tick = all {
    state' = state,
    attempts' = attempts,
    now' = now + 1,
    dueAt' = dueAt,
    lastDueAt' = lastDueAt,
    lastAttemptAt' = lastAttemptAt,
    everDelivered' = everDelivered,
    dsn' = dsn,
    lastCode' = lastCode,
  }

  // One attempt. The recipient MX answers 250, a 4xx, or a 5xx — and a 5xx is
  // permanent, so it becomes a DSN rather than a silence.
  action attempt = {
    nondet answer = Set(250, 451, 550).oneOf()
    all {
      state' = if (canAttempt)
        if (answer == 250)
          "delivered"
        else if (answer == 550) "bounced" else state
      else state,
      attempts' = if (canAttempt) attempts + 1 else attempts,
      now' = now,
      dueAt' = if (and(canAttempt, answer == 451))
        now + backoffFor(attempts + 1)
      else dueAt,
      lastDueAt' = if (canAttempt) dueAt else lastDueAt,
      lastAttemptAt' = if (canAttempt) now else lastAttemptAt,
      everDelivered' = if (and(canAttempt, answer == 250)) true else everDelivered,
      dsn' = if (and(canAttempt, answer == 550)) true else dsn,
      lastCode' = if (canAttempt) answer else lastCode,
    }
  }

  // Five attempts and still nothing: a failure by exhaustion, which is still
  // somebody's problem to hear about.
  action giveUp = all {
    state' = if (and(sendable, spent)) "bounced" else state,
    attempts' = attempts,
    now' = now,
    dueAt' = dueAt,
    lastDueAt' = lastDueAt,
    lastAttemptAt' = lastAttemptAt,
    everDelivered' = everDelivered,
    dsn' = if (and(sendable, spent)) true else dsn,
    lastCode' = if (and(sendable, spent)) 550 else lastCode,
  }

  action step = any { init, tick, attempt, giveUp }

  val StateValid: bool = or(
    state == "spooled",
    or(state == "delivered", state == "bounced")
  )
  // Five attempts, as the schedule says.
  val AttemptsBounded: bool = attempts <= 5
  // A delivery is final: delivered once, and never again.
  val DeliveredIsFinal: bool = or(not(everDelivered), state == "delivered")
  // An attempt only ever happens on the minute it was due. The schedule is
  // obeyed, rather than decoration around a loop that retries immediately.
  val AttemptOnlyWhenDue: bool = lastAttemptAt >= lastDueAt
  // A bounce is a DSN, not a silence.
  val BouncedIsReported: bool = or(not(state == "bounced"), dsn)
  // And nothing is delivered that was never tried.
  val DeliveredWasAttempted: bool = or(not(everDelivered), attempts >= 1)
}
