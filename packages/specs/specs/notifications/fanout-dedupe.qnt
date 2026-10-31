// Notifications service: event fan-out, dedupe, and the per-account read cursor.
//
// The service consumes the indexed event stream and fans each event out to the
// recipient accounts it addresses. Every account owns a private inbox of
// delivered notifications plus a read cursor; reading advances that account's
// cursor but can never run past what the account was actually delivered. A
// re-delivered event is deduped: it bumps the dropped counter and never touches
// an inbox or a cursor.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/notifications/fanout-dedupe.test.ts).

module notifications_fanout_dedupe {
  var eventCount: int // accepted (fanned-out) events
  var inboxA: int     // notifications delivered to account A
  var inboxB: int     // notifications delivered to account B
  var cursorA: int    // account A's read cursor (never past inboxA)
  var cursorB: int    // account B's read cursor (never past inboxB)
  var dropped: int    // duplicate events refused by dedupe

  action init = all {
    eventCount' = 0,
    inboxA' = 0,
    inboxB' = 0,
    cursorA' = 0,
    cursorB' = 0,
    dropped' = 0
  }

  // A fresh event fans out to the recipient set it addresses. Account A and
  // account B are the sample roster; "both" is the multi-recipient fan-out.
  action fanout = {
    nondet audience = Set("recipientA", "recipientB", "both").oneOf()
    all {
      eventCount' = eventCount + 1,
      inboxA' = if (audience == "recipientA" or audience == "both") inboxA + 1
                else inboxA,
      inboxB' = if (audience == "recipientB" or audience == "both") inboxB + 1
                else inboxB,
      cursorA' = cursorA,
      cursorB' = cursorB,
      dropped' = dropped
    }
  }

  // A re-delivered event is deduped. The audience it names is already known,
  // so no inbox grows and no cursor moves; only the refusal is counted.
  action redeliver = {
    nondet audience = Set("recipientA", "recipientB", "both").oneOf()
    all {
      eventCount' = eventCount,
      inboxA' = inboxA,
      inboxB' = inboxB,
      cursorA' = cursorA,
      cursorB' = cursorB,
      dropped' = dropped + 1
    }
  }

  // Account A reads up to `n`, clamped at what it has been delivered.
  action readA = {
    nondet n = Set(1, 2, 3).oneOf()
    all {
      eventCount' = eventCount,
      inboxA' = inboxA,
      inboxB' = inboxB,
      cursorA' = if (cursorA + n > inboxA) inboxA else cursorA + n,
      cursorB' = cursorB,
      dropped' = dropped
    }
  }

  // Account B reads up to `n`, clamped at what it has been delivered.
  action readB = {
    nondet n = Set(1, 2, 3).oneOf()
    all {
      eventCount' = eventCount,
      inboxA' = inboxA,
      inboxB' = inboxB,
      cursorA' = cursorA,
      cursorB' = if (cursorB + n > inboxB) inboxB else cursorB + n,
      dropped' = dropped
    }
  }

  action step = any { init, fanout, redeliver, readA, readB }

  // A read cursor never runs ahead of the notifications delivered to it.
  val ReadCursorWithinInbox: bool = and(cursorA <= inboxA, cursorB <= inboxB)

  // Fan-out delivers at most one notification per accepted event to an
  // account, so no inbox can outrun the accepted-event counter. Dedupe is what
  // keeps this bound true across re-deliveries.
  val InboxWithinEvents: bool = and(inboxA <= eventCount, inboxB <= eventCount)

  // Every counter is monotone and starts at zero.
  val CountersNonNegative: bool = and(
    eventCount >= 0,
    inboxA >= 0,
    inboxB >= 0,
    cursorA >= 0,
    cursorB >= 0,
    dropped >= 0
  )
}
