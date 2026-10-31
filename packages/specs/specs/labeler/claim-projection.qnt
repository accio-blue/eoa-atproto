// Labeler: the claim -> label projection - a claim is truth, a label is a view.
//
// A moderation claim records that a subject violates a policy; the label is the
// published view of that claim. Filing or upholding a claim projects a visible
// label; dismissing or withdrawing it projects a negation (the view that the
// label no longer applies); no claim projects nothing. The label is never
// authored independently - it is exactly the projection of the claim, so it can
// never claim more (or less) than the truth backs. The spec is the source of
// truth for that projection.

module labeler_claim_projection {
  var claim: str     // "none" | "filed" | "upheld" | "dismissed" | "withdrawn"
  var label: str     // "none" | "visible" | "negated"
  var revision: int  // number of projections applied

  // The projection: truth (claim) -> view (label).
  def project(claimState: str): str =
    if (claimState == "filed") "visible"
    else if (claimState == "upheld") "visible"
    else if (claimState == "dismissed") "negated"
    else if (claimState == "withdrawn") "negated"
    else "none"

  // A claim can be resolved only while it stands: filed or upheld.
  def resolvable(claimState: str): bool =
    or(claimState == "filed", claimState == "upheld")

  action init = all {
    claim' = "none",
    label' = "none",
    revision' = 0
  }

  // A claim is filed: it becomes truth and projects a visible label.
  action file = all {
    claim' = if (claim == "none") "filed" else claim,
    label' = if (claim == "none") project("filed") else label,
    revision' = if (claim == "none") revision + 1 else revision
  }

  // The claim is upheld (confirmed): the view stays visible.
  action uphold = all {
    claim' = if (claim == "filed") "upheld" else claim,
    label' = if (claim == "filed") project("upheld") else label,
    revision' = if (claim == "filed") revision + 1 else revision
  }

  // The claim is dismissed: the truth retracts and projects a negation. A
  // confirmed claim (upheld) can still be overturned this way.
  action dismiss = all {
    claim' = if (resolvable(claim)) "dismissed" else claim,
    label' = if (resolvable(claim)) project("dismissed") else label,
    revision' = if (resolvable(claim)) revision + 1 else revision
  }

  // The claim is withdrawn: same projection as a dismissal.
  action withdraw = all {
    claim' = if (resolvable(claim)) "withdrawn" else claim,
    label' = if (resolvable(claim)) project("withdrawn") else label,
    revision' = if (resolvable(claim)) revision + 1 else revision
  }

  // Re-project from the current claim: an idempotent reconciliation of the view.
  action reproject = all {
    claim' = claim,
    label' = project(claim),
    revision' = revision
  }

  action step = any { init, file, uphold, dismiss, withdraw, reproject }

  val ClaimValid: bool = or(
    claim == "none",
    claim == "filed",
    claim == "upheld",
    claim == "dismissed",
    claim == "withdrawn"
  )

  val LabelValid: bool = or(
    label == "none",
    label == "visible",
    label == "negated"
  )

  // The label is a view of the claim: it is exactly the projection, so the view
  // can never claim more (or less) than the truth backs.
  val LabelIsView: bool = label == project(claim)

  // A visible label is backed by a filed or upheld claim.
  val VisibleBackedByClaim: bool = or(
    label != "visible",
    or(claim == "filed", claim == "upheld")
  )

  // A negation necessarily denies a resolved claim, never truth.
  val NegationDeniesClaim: bool = or(
    label != "negated",
    or(claim == "dismissed", claim == "withdrawn")
  )

  // No label view can exist without a claim behind it.
  val NoLabelWithoutClaim: bool = or(label == "none", claim != "none")

  val RevisionNonNegative: bool = revision >= 0
}
