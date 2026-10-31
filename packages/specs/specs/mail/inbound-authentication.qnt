// Inbound authentication — SPF, DKIM, DMARC, and the one rule that makes any of
// it worth doing: **a message is never treated as authenticated unless a result
// actually passed *and* aligned with the domain it claims to be from.**
//
// That "and aligned" is the whole point, and it is the thing naive
// implementations get wrong. SPF authenticates the *envelope* sender; DKIM
// authenticates a *signing domain*. Neither says anything about the `From:`
// header a human will read. DMARC is the alignment check that closes that gap,
// so:
//
//   * an SPF pass on a domain that does not align with `From:` is not
//     authentication — it is the classic spoof, and scenario 2 is exactly it;
//   * DMARC passes only when SPF or DKIM passed *aligned*;
//   * and the disposition then follows the domain's published policy — never
//     "deliver it anyway".
//
// This machine is the decision only. The DNS lookups and the signature
// verification are behind a seam, because a wrong *decision* is a policy bug
// while wrong *crypto* is a vulnerability, and only one of those belongs in a
// transition function.
module mail_inbound_authentication {
  var spf: str // "none" | "pass" | "fail"
  var spfAligned: bool // the envelope domain aligns with the From domain
  var dkim: str // "none" | "pass" | "fail"
  var dkimAligned: bool // the signing domain (d=) aligns with From
  var policy: str // the domain's published policy: "none" | "quarantine" | "reject"
  var dmarc: str // "pass" | "fail", derived from the two above
  var disposition: str // "deliver" | "quarantine" | "reject"

  // One selector encodes a whole result set, so the decision is derived from the
  // same pure defs the invariants use:
  //   0 -> nothing checked (none/none)
  //   1 -> SPF passed, aligned                        -> DMARC pass
  //   2 -> SPF passed, NOT aligned                    -> DMARC fail  (the spoof)
  //   3 -> DKIM passed, aligned (SPF failed)          -> DMARC pass
  //   4 -> DKIM passed, NOT aligned (SPF failed)      -> DMARC fail
  //   5 -> both failed                                -> DMARC fail
  def spfFor(s: int): str =
    if (or(s == 1, s == 2)) "pass" else if (or(s == 3, s == 4, s == 5)) "fail" else "none"
  def spfAlignedFor(s: int): bool = s == 1
  def dkimFor(s: int): str =
    if (or(s == 3, s == 4)) "pass" else if (s == 5) "fail" else "none"
  def dkimAlignedFor(s: int): bool = s == 3
  def alignedSpf(s: int): bool = and(spfFor(s) == "pass", spfAlignedFor(s))
  def alignedDkim(s: int): bool = and(dkimFor(s) == "pass", dkimAlignedFor(s))
  def dmarcFor(s: int): str =
    if (or(alignedSpf(s), alignedDkim(s))) "pass" else "fail"
  // The disposition follows the policy, and only the policy.
  def dispositionFor(p: str, passed: bool): str =
    if (passed) "deliver" else if (p == "reject") "reject" else if (p == "quarantine") "quarantine" else "deliver"

  action init = all {
    spf' = "none",
    spfAligned' = false,
    dkim' = "none",
    dkimAligned' = false,
    policy' = "none",
    dmarc' = "fail",
    disposition' = "deliver",
  }

  // The domain's published policy. Changing it re-evaluates the disposition,
  // because the disposition is a *function* of the policy and the results —
  // leaving the old answer in place is how a mailbox ends up delivering mail a
  // tightened policy would now reject. (The exploration found exactly that.)
  action setPolicy = {
    nondet chosen = Set("none", "quarantine", "reject").oneOf()
    all {
      spf' = spf,
      spfAligned' = spfAligned,
      dkim' = dkim,
      dkimAligned' = dkimAligned,
      policy' = chosen,
      dmarc' = dmarc,
      disposition' = dispositionFor(chosen, dmarc == "pass"),
    }
  }

  action check = {
    nondet scenario = Set(0, 1, 2, 3, 4, 5).oneOf()
    all {
      spf' = spfFor(scenario),
      spfAligned' = spfAlignedFor(scenario),
      dkim' = dkimFor(scenario),
      dkimAligned' = dkimAlignedFor(scenario),
      policy' = policy,
      dmarc' = dmarcFor(scenario),
      disposition' = dispositionFor(policy, dmarcFor(scenario) == "pass"),
    }
  }

  action step = any { init, setPolicy, check }

  val DispositionValid: bool = or(
    disposition == "deliver",
    disposition == "quarantine",
    disposition == "reject"
  )
  // The headline: authentication means a pass *and* alignment, never a bare pass.
  val DmarcPassImpliesAlignedPass: bool = or(
    not(dmarc == "pass"),
    or(and(spf == "pass", spfAligned), and(dkim == "pass", dkimAligned))
  )
  // A rejection is the domain's decision, not ours.
  val RejectOnlyUnderRejectPolicy: bool = or(
    not(disposition == "reject"),
    policy == "reject"
  )
  val QuarantineOnlyUnderQuarantinePolicy: bool = or(
    not(disposition == "quarantine"),
    policy == "quarantine"
  )
  // Under a policy that says something, unauthenticated mail is never delivered.
  val DeliveredUnderPolicyImpliesPass: bool = or(
    not(and(disposition == "deliver", not(policy == "none"))),
    dmarc == "pass"
  )
}
