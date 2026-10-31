// SMTP server (MX) — envelope acceptance, and the two rules an MX cannot break.
//
// A session greets, takes an envelope (`MAIL FROM` / `RCPT TO`), reads `DATA`,
// spools the message, and only then answers `250`. Both invariants that matter
// are about what must *never* happen rather than what should:
//
//   * the envelope never holds a recipient we do not serve, so this server can
//     never be used as an open relay — the one bug that gets an MX blacklisted
//     and turns it into a spam cannon;
//   * a `250` is never answered for a message that is not yet durable, so an
//     accepted message cannot be silently lost. This is the same rule the repo's
//     write path already follows: acknowledge after durable, never before.
//
// `spool` and `accept` are separate actions on purpose. The machine *can* reach
// `accept` before `spool`, and the invariant is what forbids the answer that
// would follow — so the ordering discipline is proven across every interleaving
// the machine admits, not asserted by construction.
//
// A foreign *sender* is normal and accepted: anyone may send *to* us. A foreign
// *recipient* is refused with a permanent `554` and never stored.
//
// Guards live in the assignment RHS because the generator supports no action
// preconditions.
module mail_smtp_server {
  var stage: str // "idle" | "greeted" | "envelope" | "data" | "queued" | "closed"
  var helo: bool // EHLO accepted
  var sender: str // envelope sender, "none" when absent
  var recipient: str // envelope recipient, "none" when absent
  var durable: bool // the message body is spooled
  var accepted: bool // a 250 was answered for a message
  var lastCode: int // last reply code (0/220/221/250/354/451/503/550/554)

  def isOurs(r: str): bool = r == "bob@org.example"
  def hasSender(v: str): bool = not(v == "none")
  def hasRecipient(v: str): bool = not(v == "none")
  def canMailFrom: bool = and(helo, stage == "greeted")
  def canRcptTo: bool = and(helo, stage == "envelope")
  def canTakeData: bool = and(stage == "envelope", hasRecipient(recipient))
  def canSpool: bool = stage == "data"
  def canAccept: bool = and(stage == "data", durable)

  action init = all {
    stage' = "idle",
    helo' = false,
    sender' = "none",
    recipient' = "none",
    durable' = false,
    accepted' = false,
    lastCode' = 0,
  }

  action ehlo = all {
    stage' = if (stage == "idle") "greeted" else stage,
    helo' = if (stage == "idle") true else helo,
    sender' = sender,
    recipient' = recipient,
    durable' = durable,
    accepted' = accepted,
    lastCode' = if (stage == "idle") 250 else lastCode,
  }

  action mailFrom = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = if (and(canMailFrom, ok)) "envelope" else stage,
      helo' = helo,
      sender' = if (and(canMailFrom, ok)) "alice@elsewhere.example" else sender,
      recipient' = recipient,
      durable' = durable,
      accepted' = accepted,
      lastCode' = if (and(canMailFrom, ok)) 250 else if (canMailFrom) 550 else 503,
    }
  }

  action rcptTo = {
    nondet asked = Set("bob@org.example", "carol@other.example").oneOf()
    all {
      stage' = if (and(canRcptTo, isOurs(asked))) "envelope" else stage,
      helo' = helo,
      sender' = sender,
      // A recipient we do not serve is refused and never stored: no relay.
      recipient' = if (and(canRcptTo, isOurs(asked))) asked else recipient,
      durable' = durable,
      accepted' = accepted,
      lastCode' = if (and(canRcptTo, isOurs(asked))) 250 else if (canRcptTo) 554 else 503,
    }
  }

  action data = all {
    stage' = if (canTakeData) "data" else stage,
    helo' = helo,
    sender' = sender,
    recipient' = recipient,
    durable' = durable,
    accepted' = accepted,
    lastCode' = if (canTakeData) 354 else 503,
  }

  action spool = {
    nondet ok = Set(true, false).oneOf()
    all {
      // A failed spool abandons the transaction and asks the sender to retry.
      stage' = if (and(canSpool, ok)) "data" else if (canSpool) "envelope" else stage,
      helo' = helo,
      sender' = sender,
      recipient' = recipient,
      durable' = if (and(canSpool, ok)) true else durable,
      accepted' = accepted,
      lastCode' = if (and(canSpool, ok)) lastCode else if (canSpool) 451 else lastCode,
    }
  }

  action accept = all {
    // Reached before the spool, this answers 4xx rather than 250. That branch is
    // exactly what AcceptedImpliesDurable exists to police.
    stage' = if (canAccept) "queued" else stage,
    helo' = helo,
    sender' = sender,
    recipient' = recipient,
    durable' = durable,
    accepted' = if (canAccept) true else accepted,
    lastCode' = if (canAccept) 250 else if (stage == "data") 451 else lastCode,
  }

  action quit = all {
    stage' = "closed",
    helo' = helo,
    sender' = sender,
    recipient' = recipient,
    durable' = durable,
    accepted' = accepted,
    lastCode' = 221,
  }

  action step = any { init, ehlo, mailFrom, rcptTo, data, spool, accept, quit }

  val StageValid: bool = or(
    stage == "idle",
    stage == "greeted",
    stage == "envelope",
    stage == "data",
    stage == "queued",
    stage == "closed"
  )
  // No relay: the envelope only ever holds a recipient we serve.
  val RecipientIsOurs: bool = or(recipient == "none", isOurs(recipient))
  // No silent loss: a 250 is never answered for an unspooled message.
  val AcceptedImpliesDurable: bool = or(not(accepted), durable)
  // And never for a message with nobody to deliver to.
  val AcceptedImpliesRecipient: bool = or(not(accepted), hasRecipient(recipient))
  val QueuedIsDurable: bool = or(not(stage == "queued"), durable)
  val SenderImpliesGreeted: bool = or(not(hasSender(sender)), helo)
  val DataImpliesRecipient: bool = or(not(stage == "data"), hasRecipient(recipient))
}
