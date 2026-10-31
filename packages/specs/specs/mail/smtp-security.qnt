// SMTP submission security — STARTTLS, AUTH, and the rules a mail server must
// not break once it is reachable by the world.
//
// This is the second half of `smtp-server.qnt`, and its invariants are security
// invariants rather than correctness ones:
//
//   * credentials are never accepted on a session that is not encrypted — the
//     one rule that makes offering AUTH at all defensible;
//   * **STARTTLS discards the transaction.** RFC 3207 is explicit: a session that
//     upgrades must forget everything it was told before, or a man in the middle
//     can inject an envelope and have it survive the upgrade. The epoch is how
//     that is modelled: every greeting, upgrade and reset bumps it, and an
//     envelope only counts in the epoch it was recorded in.
//   * an upgrade happens at most once, and cannot happen without a certificate.
//   * **a remote recipient requires authentication.** This is the rule that
//     separates a relay from an open relay, and it is the reason `accepts` sees
//     the session rather than only the address: an MX serves its own domains to
//     anybody, and a submission port serves *any* recipient — but only for a
//     member it has authenticated. A policy that could not see `authed` could not
//     say that, and the only way to write a relay with one would be to accept
//     everything, which is not a policy.
//
// Two policies share the machine, because they are the same dialogue with
// different strictness — which is the real design point, not an accident:
//
//   * an **MX** (port 25, inbound) is *opportunistic*: it offers STARTTLS and
//     still accepts mail from a sender that declines, because it cannot demand
//     encryption from the whole internet;
//   * **submission** (port 587, our own users) is *strict*: no envelope opens
//     before TLS, and anything not addressed to us needs a login.
//
// One nondet selector (`setup`) picks the deployment: certificate offered or
// not, policy strict or not. Guards live in the assignment RHS because the
// generator supports no action preconditions.
module mail_smtp_security {
  var stage: str // "idle" | "greeted" | "envelope" | "closed"
  var tls: bool // the session is encrypted
  var offers: bool // a certificate is configured, so STARTTLS may be advertised
  var strict: bool // the policy: no envelope before TLS (submission)
  var upgrades: int // how many STARTTLS upgrades happened
  var authed: bool // credentials were accepted
  var sender: str // envelope sender, "none" when absent
  var recipient: str // "none" | "served" | "remote" — the last accepted recipient
  var epoch: int // the transaction epoch: bumped by greeting, upgrade, reset
  var senderEpoch: int // the epoch the sender was recorded in
  var awaitingAuth: bool // a bare AUTH was sent; the payload is the next line
  var lastCode: int // last reply code (0/220/221/235/250/334/454/503/530/535/554)

  def hasSender(v: str): bool = not(v == "none")
  def isRemote(v: str): bool = v == "remote"
  def offersFor(s: int): bool = or(s == 1, s == 3)
  def strictFor(s: int): bool = or(s == 2, s == 3)
  // STARTTLS is available in any open session that has a certificate and has not
  // upgraded already — *including* mid-transaction, which is the case the
  // upgrade-discards-the-envelope rule exists for.
  def canStartTls: bool = and(
    and(offers, or(stage == "greeted", stage == "envelope")),
    upgrades == 0
  )
  // An envelope opens only when the policy is satisfied: opportunistic always,
  // strict only once encrypted.
  def mayOpenEnvelope: bool = and(stage == "greeted", or(not(strict), tls))
  action init = all {
    stage' = "idle",
    tls' = false,
    offers' = false,
    strict' = false,
    upgrades' = 0,
    authed' = false,
    awaitingAuth' = false,
    sender' = "none",
    recipient' = "none",
    epoch' = 0,
    senderEpoch' = 0,
    lastCode' = 0,
  }

  // The deployment: a certificate, and a policy. Settable only while idle,
  // because a policy that could change mid-transaction would let an envelope
  // outlive the rule that allowed it — which is exactly what the exploration
  // found when this was reachable from every stage.
  action configure = {
    nondet setup = Set(0, 1, 2, 3).oneOf()
    all {
      stage' = stage,
      tls' = tls,
      offers' = if (stage == "idle") offersFor(setup) else offers,
      strict' = if (stage == "idle") strictFor(setup) else strict,
      upgrades' = upgrades,
      authed' = authed,
      awaitingAuth' = awaitingAuth,
      sender' = sender,
      recipient' = recipient,
      epoch' = epoch,
      senderEpoch' = senderEpoch,
      lastCode' = lastCode,
    }
  }

  // A greeting opens a fresh transaction — the envelope from before it is gone.
  action ehlo = all {
    stage' = "greeted",
    tls' = tls,
    offers' = offers,
    strict' = strict,
    upgrades' = upgrades,
    authed' = authed,
    // A greeting and a reset both open a fresh transaction, so a pending auth
    // continuation is discarded with everything else.
    awaitingAuth' = false,
    sender' = "none",
    recipient' = "none",
    epoch' = epoch + 1,
    senderEpoch' = epoch + 1,
    lastCode' = 250,
  }

  action starttls = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = if (and(canStartTls, ok)) "greeted" else stage,
      tls' = if (and(canStartTls, ok)) true else tls,
      offers' = offers,
      strict' = strict,
      upgrades' = if (and(canStartTls, ok)) upgrades + 1 else upgrades,
      authed' = authed,
      // Everything told before the upgrade is discarded — a pending auth
      // continuation with the rest.
      awaitingAuth' = false,
      sender' = if (and(canStartTls, ok)) "none" else sender,
      recipient' = if (and(canStartTls, ok)) "none" else recipient,
      epoch' = if (and(canStartTls, ok)) epoch + 1 else epoch,
      senderEpoch' = if (and(canStartTls, ok)) epoch + 1 else senderEpoch,
      lastCode' = if (and(canStartTls, ok)) 220 else if (canStartTls) 454 else 503,
    }
  }

  // The one-step form: `AUTH PLAIN <base64>`. What `smtplib` sends.
  //
  // `authed` is `or(authed, ...)` rather than assigned, and that is not a
  // stylistic choice: authentication belongs to the *connection*, not to the
  // transaction, so a later failed attempt must not un-authenticate a session that
  // has already authenticated. The implementation has always done this (a refused
  // `AUTH` returns the session unchanged); the model assigned instead, and the
  // relay invariant below is what made the difference visible.
  action auth = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = stage,
      tls' = tls,
      offers' = offers,
      strict' = strict,
      upgrades' = upgrades,
      // Reached without TLS, this is refused outright rather than tried.
      authed' = or(authed, and(tls, ok)),
      awaitingAuth' = false,
      sender' = sender,
      recipient' = recipient,
      epoch' = epoch,
      senderEpoch' = senderEpoch,
      lastCode' = if (tls) if (ok) 235 else 535 else 530,
    }
  }

  // The bare form: `AUTH PLAIN`, then the payload on the next line. Legal (RFC
  // 4954), and what `curl` sends — and it was answered `500` while being sent
  // exactly what it asks for, because the two-step spelling had no state.
  //
  // The `334` is the server *asking for the password*. Asking in the clear is the
  // leak that refusing the credentials afterwards does not undo, so it may only be
  // asked on an encrypted session — which is what `AskingImpliesTls` pins.
  action authStart = all {
    stage' = stage,
    tls' = tls,
    offers' = offers,
    strict' = strict,
    upgrades' = upgrades,
    authed' = authed,
    awaitingAuth' = if (tls) true else awaitingAuth,
    sender' = sender,
    recipient' = recipient,
    epoch' = epoch,
    senderEpoch' = senderEpoch,
    lastCode' = if (tls) 334 else 530,
  }

  // The payload line. While awaiting, the next line *is* the payload whatever it
  // says — which is what a continuation means, and why a client that sends a
  // command there is answered `535` rather than obeyed.
  action authPayload = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = stage,
      tls' = tls,
      offers' = offers,
      strict' = strict,
      upgrades' = upgrades,
      authed' = if (and(awaitingAuth, ok)) true else authed,
      awaitingAuth' = false,
      sender' = sender,
      recipient' = recipient,
      epoch' = epoch,
      senderEpoch' = senderEpoch,
      lastCode' = if (awaitingAuth) if (ok) 235 else 535 else 503,
    }
  }

  action mailFrom = {
    nondet ok = Set(true, false).oneOf()
    all {
      stage' = if (and(mayOpenEnvelope, ok)) "envelope" else stage,
      tls' = tls,
      offers' = offers,
      strict' = strict,
      upgrades' = upgrades,
      authed' = authed,
      awaitingAuth' = awaitingAuth,
      sender' = if (and(mayOpenEnvelope, ok)) "alice@elsewhere.example" else sender,
      epoch' = epoch,
      senderEpoch' = if (and(mayOpenEnvelope, ok)) epoch else senderEpoch,
      // A sender opens a transaction, so whatever recipients it had are gone.
      recipient' = if (and(mayOpenEnvelope, ok)) "none" else recipient,
      lastCode' = if (and(mayOpenEnvelope, ok)) 250 else if (mayOpenEnvelope) 550 else 530,
    }
  }

  // A recipient we serve. Ours to take, from anybody: this is the MX's ordinary
  // job, and it is why the relay rule below is about *remote* recipients and
  // nothing else.
  action recipientLocal = {
    nondet took = Set(true, false).oneOf()
    all {
      stage' = stage,
      tls' = tls,
      offers' = offers,
      strict' = strict,
      upgrades' = upgrades,
      authed' = authed,
      awaitingAuth' = awaitingAuth,
      sender' = sender,
      recipient' = if (and(stage == "envelope", took)) "served" else recipient,
      epoch' = epoch,
      senderEpoch' = senderEpoch,
      lastCode' = if (stage == "envelope") if (took) 250 else 554 else 503,
    }
  }

  // A recipient we do **not** serve. Taken only for a member this session has
  // authenticated — the rule that separates a relay from an open relay, written
  // where it cannot be missed, with `RemoteImpliesAuthed` below as the same line
  // said again as a predicate. The next person to loosen this has to break two
  // things.
  action recipientRemote = {
    nondet took = Set(true, false).oneOf()
    all {
      stage' = stage,
      tls' = tls,
      offers' = offers,
      strict' = strict,
      upgrades' = upgrades,
      authed' = authed,
      awaitingAuth' = awaitingAuth,
      sender' = sender,
      recipient' = if (and(stage == "envelope", and(took, authed)))
        "remote"
      else recipient,
      epoch' = epoch,
      senderEpoch' = senderEpoch,
      lastCode' = if (stage == "envelope")
        if (and(took, authed)) 250 else 554
      else 503,
    }
  }

  action rset = all {
    stage' = "greeted",
    tls' = tls,
    offers' = offers,
    strict' = strict,
    upgrades' = upgrades,
    authed' = authed,
    // A greeting and a reset both open a fresh transaction, so a pending auth
    // continuation is discarded with everything else.
    awaitingAuth' = false,
    sender' = "none",
    recipient' = "none",
    epoch' = epoch + 1,
    senderEpoch' = epoch + 1,
    lastCode' = 250,
  }

  action quit = all {
    stage' = "closed",
    tls' = tls,
    offers' = offers,
    strict' = strict,
    upgrades' = upgrades,
    authed' = authed,
    awaitingAuth' = awaitingAuth,
    sender' = sender,
    recipient' = recipient,
    epoch' = epoch,
    senderEpoch' = senderEpoch,
    lastCode' = 221,
  }

  action step = any {
    init,
    configure,
    ehlo,
    starttls,
    auth,
    authStart,
    authPayload,
    mailFrom,
    recipientLocal,
    recipientRemote,
    rset,
    quit,
  }

  val StageValid: bool = or(
    stage == "idle",
    or(stage == "greeted", or(stage == "envelope", stage == "closed"))
  )
  // The headline: credentials are never accepted without encryption.
  val NoAuthBeforeTls: bool = or(not(authed), tls)
  // And the other half of it: the `334` *asks for* the password, so asking in the
  // clear is the leak — a refusal afterwards does not take it back.
  val AskingImpliesTls: bool = or(not(awaitingAuth), tls)
  // And a session is never encrypted without a certificate behind it.
  val TlsImpliesOffered: bool = or(not(tls), offers)
  val UpgradeAtMostOnce: bool = upgrades <= 1
  // The upgrade discards the transaction: an envelope only counts in its epoch.
  val EnvelopeFromThisEpoch: bool = or(
    not(hasSender(sender)),
    senderEpoch == epoch
  )
  // Strict means strict: no envelope before TLS.
  val StrictImpliesTlsForEnvelope: bool = or(
    not(strict),
    or(not(hasSender(sender)), tls)
  )
  // TLS cannot precede a greeting: there is nothing to upgrade until EHLO.
  val TlsImpliesGreeted: bool = or(not(tls), not(stage == "idle"))
  // The relay rule: an envelope holds somebody else's domain only when this
  // session has authenticated. Without this, `accepts: () => true` is all it takes
  // to become an open relay, which is the one mistake in this file that a scanner
  // finds for you.
  val RemoteImpliesAuthed: bool = or(not(isRemote(recipient)), authed)
}
