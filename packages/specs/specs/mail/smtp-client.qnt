// SMTP submission from our side — the client's half of `smtp-security.qnt`.
//
// The same dialogue seen from the other end, and the invariants are the ones a
// *client* must not break. They are not the server's invariants even though they
// are about the same rules, and the difference is the whole point:
//
//   * **credentials are never sent on a session that is not encrypted.** The
//     server refuses them with 530 — but a client that was *going* to send them
//     has already leaked the password to whoever is listening, and a refusal does
//     not undo that. So this is the client's rule, enforced before the wire.
//   * **a downgrade is not an upgrade.** A man in the middle can strip STARTTLS
//     from the EHLO reply, so what the server advertises is something the client
//     *learns* and can learn wrong. With credentials configured and no
//     encryption, the client abandons rather than continues in the clear.
//   * **capabilities are re-learned after the upgrade.** RFC 3207 is explicit
//     that the client must discard what it was told before STARTTLS and EHLO
//     again — otherwise it is authenticating on capabilities a man in the middle
//     supplied. `regreeted` is the witness, and `AuthOnlyAfterReGreeting` is why
//     it exists.
//   * **`DATA` only after an accepted `RCPT`.** One `DATA` can accept some
//     recipients and refuse others, so the client counts them separately and will
//     not hand over a message nobody agreed to take.
//   * **a closed session does nothing**, which every guard says — including
//     `canUpgrade`, where leaving it out was a bug this machine's own
//     "closed is final" check found.
//
// Two things the machine *deliberately* does not have, and they are worth
// naming because both were considered and dropped:
//
//   * **no `RSET`**, so one message per session. That is what `sendMail` is; a
//     client that reuses a connection is a later slice with its own machine.
//   * **no monotone "ever accepted" witness.** The IMAP machine needed one,
//     because a served message is history and the mailbox is state. Here the
//     reset is unreachable after a send — an envelope needs `authed`, which needs
//     an upgrade, and an upgrade happens at most once and only before any of it —
//     so `accepted` never has a send to erase, and the plain state predicate is
//     true rather than convenient. `explore` is what proves it.
//
// Guards live in the assignment RHS because the generator supports no action
// preconditions.
module mail_smtp_client {
  var stage: str // "idle" | "greeted" | "envelope" | "sent" | "closed"
  var tls: bool // the session is encrypted
  var advertised: bool // the server offered STARTTLS — learned, so it can be wrong
  var authed: bool // credentials were sent *and* accepted
  var accepted: int // recipients the server took, in this transaction
  var refused: int // recipients it refused, in this transaction
  var tries: int // STARTTLS attempts
  var regreeted: bool // EHLO again after the upgrade
  var sent: bool // a message was handed over
  var lastCode: int // last reply code (0/220/221/235/250/451/454/503/530/535/550)

  def open: bool = not(stage == "closed")
  def canGreet: bool = and(open, or(stage == "idle", stage == "greeted"))
  def canUpgrade: bool = and(and(advertised, open), tries == 0)
  // The two guards that are the whole point: encrypted, *and* re-greeted after it.
  def canAuth: bool = and(and(tls, regreeted), open)
  def canEnvelope: bool = and(and(authed, open), stage == "greeted")
  def canRcpt: bool = and(stage == "envelope", open)
  def canData: bool = and(and(accepted > 0, stage == "envelope"), open)

  action init = all {
    stage' = "idle",
    tls' = false,
    advertised' = false,
    authed' = false,
    accepted' = 0,
    refused' = 0,
    tries' = 0,
    regreeted' = false,
    sent' = false,
    lastCode' = 0,
  }

  // The server's 220.
  action greeting = all {
    stage' = if (canGreet) "greeted" else stage,
    tls' = tls,
    advertised' = advertised,
    authed' = authed,
    accepted' = accepted,
    refused' = refused,
    tries' = tries,
    regreeted' = regreeted,
    sent' = sent,
    lastCode' = if (canGreet) 220 else lastCode,
  }

  // EHLO — where the capabilities are learned, and so where a downgrade happens.
  // `advertised` only ever moves to true: the server said it once, and a later
  // reply that omits it is not the server un-saying it.
  action ehlo = {
    nondet advertises = Set(true, false).oneOf()
    all {
      stage' = if (canGreet) "greeted" else stage,
      tls' = tls,
      advertised' = if (and(canGreet, advertises)) true else advertised,
      authed' = authed,
      accepted' = accepted,
      refused' = refused,
      tries' = tries,
      regreeted' = if (and(canGreet, tls)) true else regreeted,
      sent' = sent,
      lastCode' = if (canGreet) 250 else lastCode,
    }
  }

  // The upgrade. Success discards the transaction *and* the capabilities — RFC
  // 3207's rule, from the client's side: nothing told before it is trusted after.
  action starttls = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = if (and(canUpgrade, ok)) "greeted" else stage,
      tls' = if (and(canUpgrade, ok)) true else tls,
      advertised' = advertised,
      authed' = if (and(canUpgrade, ok)) false else authed,
      accepted' = if (and(canUpgrade, ok)) 0 else accepted,
      refused' = if (and(canUpgrade, ok)) 0 else refused,
      tries' = if (canUpgrade) tries + 1 else tries,
      regreeted' = if (and(canUpgrade, ok)) false else regreeted,
      sent' = sent,
      lastCode' = if (and(canUpgrade, ok))
        220
      else if (canUpgrade) 454 else if (open) 503 else lastCode,
    }
  }

  // Sending credentials. Reached without encryption — or without re-greeting —
  // this is refused outright rather than tried, which is the client's own rule.
  action auth = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = stage,
      tls' = tls,
      advertised' = advertised,
      authed' = if (and(canAuth, ok)) true else authed,
      accepted' = accepted,
      refused' = refused,
      tries' = tries,
      regreeted' = regreeted,
      sent' = sent,
      lastCode' = if (canAuth)
        if (ok) 235 else 535
      else if (open) 530 else lastCode,
    }
  }

  // Giving up, which is what a client with credentials does when the session is
  // not encrypted. Not a failure — the alternative was leaking the password.
  action abandon = all {
    stage' = if (and(not(canAuth), open)) "closed" else stage,
    tls' = tls,
    advertised' = advertised,
    authed' = authed,
    accepted' = accepted,
    refused' = refused,
    tries' = tries,
    regreeted' = regreeted,
    sent' = sent,
    lastCode' = if (and(not(canAuth), open)) 530 else lastCode,
  }

  action mailFrom = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = if (and(canEnvelope, ok)) "envelope" else stage,
      tls' = tls,
      advertised' = advertised,
      authed' = authed,
      accepted' = accepted,
      refused' = refused,
      tries' = tries,
      regreeted' = regreeted,
      sent' = sent,
      lastCode' = if (canEnvelope)
        if (ok) 250 else 550
      else if (open) 503 else lastCode,
    }
  }

  // One recipient. Accepted and refused are counted apart, because one DATA can
  // take some and refuse others.
  action rcpt = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = stage,
      tls' = tls,
      advertised' = advertised,
      authed' = authed,
      accepted' = if (and(canRcpt, ok)) accepted + 1 else accepted,
      refused' = if (and(canRcpt, ok)) refused else if (canRcpt)
        refused + 1
      else refused,
      tries' = tries,
      regreeted' = regreeted,
      sent' = sent,
      lastCode' = if (canRcpt) if (ok) 250 else 550 else if (open) 503 else lastCode,
    }
  }

  action data = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = if (and(canData, ok)) "sent" else stage,
      tls' = tls,
      advertised' = advertised,
      authed' = authed,
      accepted' = accepted,
      refused' = refused,
      tries' = tries,
      regreeted' = regreeted,
      sent' = if (and(canData, ok)) true else sent,
      lastCode' = if (canData) if (ok) 250 else 451 else if (open) 503 else lastCode,
    }
  }

  action quit = all {
    stage' = if (open) "closed" else stage,
    tls' = tls,
    advertised' = advertised,
    authed' = authed,
    accepted' = accepted,
    refused' = refused,
    tries' = tries,
    regreeted' = regreeted,
    sent' = sent,
    lastCode' = if (open) 221 else lastCode,
  }

  action step = any {
    init,
    greeting,
    ehlo,
    starttls,
    auth,
    abandon,
    mailFrom,
    rcpt,
    data,
    quit,
  }

  val StageValid: bool = or(
    stage == "idle",
    stage == "greeted",
    or(stage == "envelope", or(stage == "sent", stage == "closed"))
  )
  // The headline: credentials are never sent without encryption.
  val NoCredentialsInTheClear: bool = or(not(authed), tls)
  // And never on capabilities from before the upgrade — the man-in-the-middle's.
  val AuthOnlyAfterReGreeting: bool = or(not(authed), regreeted)
  // Encryption only ever follows an offer the server actually made.
  val TlsImpliesAdvertised: bool = or(not(tls), advertised)
  val UpgradeAtMostOnce: bool = tries <= 1
  // A message is only ever handed over once somebody agreed to take it. The
  // plain state predicate, not a witness: an upgrade could only erase the count
  // before a send, which the guards make impossible.
  val SentImpliesAccepted: bool = or(not(sent), accepted > 0)
  // The envelope belongs to an authenticated session: this is a submission client.
  val EnvelopeImpliesAuthed: bool = or(
    not(or(stage == "envelope", stage == "sent")),
    authed
  )
  // One message per session, deliberately: after a send the session is done, and
  // the only way out is to close it.
  val NoSecondEnvelope: bool = or(
    not(sent),
    or(stage == "sent", stage == "closed")
  )
}
