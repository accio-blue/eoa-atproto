// Moderation service: the appeal window + review.
//
// Each enforcement action opens a filing window. The subject may file exactly
// one appeal while that window is open; an unused window lapses and can never
// be filed against afterwards. A filed appeal is reviewed, and the ruling
// either grants it (reversing the action) or denies it (leaving the action in
// force). The filing window is guarded so a lapsed window never carries an
// appeal.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/moderation/appeal-lifecycle.test.ts).

module moderation_appeal_lifecycle {
  var appeal: str    // "none" | "filed" | "reviewing" | "granted" | "denied"
  var filing: str    // "none" | "open" | "lapsed"
  var standing: bool // the underlying enforcement action is in force

  action init = all {
    appeal' = "none",
    filing' = "none",
    standing' = false
  }

  // an enforcement action opens a fresh appeal window
  action enforce = all {
    appeal' = "none",
    filing' = "open",
    standing' = true
  }

  // the window closes unfiled
  action lapse = all {
    appeal' = appeal,
    filing' = if (filing == "open" and appeal == "none") "lapsed" else filing,
    standing' = standing
  }

  // the subject files an appeal inside the open window
  action file = all {
    appeal' = if (filing == "open" and appeal == "none") "filed" else appeal,
    filing' = filing,
    standing' = standing
  }

  // a filed appeal is taken up for review
  action review = all {
    appeal' = if (appeal == "filed") "reviewing" else appeal,
    filing' = filing,
    standing' = standing
  }

  // a reviewed appeal grants (reversing the action) or denies it
  action rule = {
    nondet grant = Set(true, false).oneOf()
    all {
      appeal' = if (appeal == "reviewing" and grant) "granted"
                else if (appeal == "reviewing") "denied"
                else appeal,
      filing' = filing,
      standing' = if (appeal == "reviewing" and grant) false else standing
    }
  }

  action step = any { init, enforce, lapse, file, review, rule }

  val AppealValid: bool = or(
    appeal == "none",
    appeal == "filed",
    appeal == "reviewing",
    appeal == "granted",
    appeal == "denied"
  )
  val FilingValid: bool = or(
    filing == "none",
    filing == "open",
    filing == "lapsed"
  )
  // a filed appeal requires an open window
  val AppealNeedsOpenFiling: bool =
    or(appeal == "none", filing == "open")
  // a lapsed window never carries an appeal
  val LapsedHasNoAppeal: bool =
    or(filing != "lapsed", appeal == "none")
  // granting an appeal reverses the enforcement action
  val GrantedReverses: bool =
    or(appeal != "granted", not(standing))
  // denying an appeal leaves the action in force
  val DeniedKeepsStanding: bool =
    or(appeal != "denied", standing)
}
