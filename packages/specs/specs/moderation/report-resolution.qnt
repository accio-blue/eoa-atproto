// Moderation service: the report -> action -> appeal spine.
//
// A report enters the queue, is triaged, and is resolved with exactly one
// verdict: a takedown, a label, or no action (a dismissal). Only an
// enforceable verdict (takedown/label) can be appealed, and an appeal always
// starts from a fully resolved report. The appeal state is never staged ahead
// of enforcement: it is derived from the path the report actually took.
//
// This is the service's first and widest machine; the takedown-action,
// appeal-lifecycle and reply-window machines decompose the same vocabulary in
// more depth. The spec is the source of truth; the generated model document
// drives the spec-only verification (test/moderation/report-resolution.test.ts).

module moderation_report_resolution {
  var report: str    // "none" | "open" | "triaged" | "resolved" | "dismissed"
  var decision: str  // "none" | "takedown" | "label" | "noaction"
  var appeal: str    // "none" | "filed" | "granted" | "denied"

  // an enforceable verdict is one an appeal can target
  def actionable(value: str): bool =
    or(value == "takedown", value == "label")

  action init = all {
    report' = "none",
    decision' = "none",
    appeal' = "none"
  }

  // a fresh report enters the queue; submitting over a live report is a no-op
  action submit = all {
    report' = if (report == "none") "open" else report,
    decision' = if (report == "none") "none" else decision,
    appeal' = if (report == "none") "none" else appeal
  }

  // triage: an open report becomes ready for a verdict
  action triage = all {
    report' = if (report == "open") "triaged" else report,
    decision' = decision,
    appeal' = appeal
  }

  // resolve: take an enforcement action, or dismiss with no action
  action decide = {
    nondet verdict = Set("takedown", "label", "noaction").oneOf()
    all {
      report' = if (report == "triaged" and verdict == "noaction") "dismissed"
                else if (report == "triaged") "resolved"
                else report,
      decision' = if (report == "triaged") verdict else decision,
      appeal' = appeal
    }
  }

  // the subject appeals an enforcement verdict
  action fileAppeal = all {
    report' = report,
    decision' = decision,
    appeal' = if (report == "resolved" and actionable(decision) and appeal == "none") "filed"
              else appeal
  }

  // the appeal is reviewed: granting it reverses the action, denying it stands
  action decideAppeal = {
    nondet ruling = Set("granted", "denied").oneOf()
    all {
      report' = report,
      decision' = decision,
      appeal' = if (appeal == "filed") ruling else appeal
    }
  }

  action step = any { init, submit, triage, decide, fileAppeal, decideAppeal }

  val ReportValid: bool = or(
    report == "none",
    report == "open",
    report == "triaged",
    report == "resolved",
    report == "dismissed"
  )
  val DecisionValid: bool = or(
    decision == "none",
    decision == "takedown",
    decision == "label",
    decision == "noaction"
  )
  val AppealValid: bool = or(
    appeal == "none",
    appeal == "filed",
    appeal == "granted",
    appeal == "denied"
  )
  // a verdict exists only once triage has moved the report out of the queue
  val DecisionNeedsResolution: bool =
    or(decision == "none", or(report == "resolved", report == "dismissed"))
  // a dismissal is always the no-action verdict
  val DismissedIsNoAction: bool =
    or(report != "dismissed", decision == "noaction")
  // an appeal exists only after an enforceable verdict resolved the report
  val AppealNeedsEnforcement: bool =
    or(appeal == "none", and(report == "resolved", actionable(decision)))
}
