// Labeler: the agent-attribution label - a record whose author is an agent.
//
// A record's author is the DID that wrote it. When that DID carries a
// `ing.lexicon.agent.provenance` record it is an agent acting for a principal,
// and the labeler projects an attribution label over the author's records, so
// feeds and moderation can tell agent-authored content from human-authored
// content. The truth is the author's provenance record; the label is its view.
//
// A human author is not a subject of this label at all: the projection is
// "none", so no label is ever emitted over a human's records. The spec is the
// source of truth for that projection.

module labeler_agent_attribution {
  var author: str      // "unknown" | "human" | "agent" - the record's author DID
  var provenance: str  // "none" | "declared" | "withdrawn" - the author's provenance record
  var label: str       // "none" | "visible" | "negated"

  def isAgent(kind: str): bool = kind == "agent"

  // The projection: the author's kind and provenance record -> the label view.
  // Only an agent author is a subject; a declared provenance is visible, a
  // withdrawn one is a negation, anything else projects nothing.
  def project(kind: str, prov: str): str =
    if (and(isAgent(kind), prov == "declared")) "visible"
    else if (and(isAgent(kind), prov == "withdrawn")) "negated"
    else "none"

  action init = all {
    author' = "unknown",
    provenance' = "none",
    label' = "none"
  }

  // The author DID is resolved: it is an agent, or it is not.
  action resolve = {
    nondet kind = Set("human", "agent").oneOf()
    all {
      author' = kind,
      provenance' = provenance,
      label' = project(kind, provenance)
    }
  }

  // The author's provenance record is published: the label becomes visible.
  action declare = all {
    author' = author,
    provenance' = if (isAgent(author)) "declared" else provenance,
    label' = if (isAgent(author)) project(author, "declared") else label
  }

  // The provenance record is withdrawn: the attribution is negated.
  action withdraw = all {
    author' = author,
    provenance' =
      if (and(isAgent(author), provenance == "declared")) "withdrawn"
      else provenance,
    label' =
      if (and(isAgent(author), provenance == "declared"))
        project(author, "withdrawn")
      else label
  }

  // Re-project from the current facts: an idempotent reconciliation of the view.
  action reproject = all {
    author' = author,
    provenance' = provenance,
    label' = project(author, provenance)
  }

  action step = any { init, resolve, declare, withdraw, reproject }

  val AuthorValid: bool = or(
    author == "unknown",
    author == "human",
    author == "agent"
  )

  val ProvenanceValid: bool = or(
    provenance == "none",
    provenance == "declared",
    provenance == "withdrawn"
  )

  val LabelValid: bool = or(
    label == "none",
    label == "visible",
    label == "negated"
  )

  // The label is exactly the projection of the facts, never authored
  // independently.
  val LabelIsProjection: bool = label == project(author, provenance)

  // A visible attribution label is backed by an agent author.
  val VisibleImpliesAgent: bool = or(label != "visible", isAgent(author))

  // A human author is never decorated with this label.
  val HumanUndecorated: bool = or(author != "human", label == "none")
}
