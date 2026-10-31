// PDS account move: an account's journey from one PDS to another.
//
// A move is a sequence of steps that can each fail and be retried, so what the spec has to pin is
// not what the steps *do* — the `Source`/`Destination` ports own that — but the **order**: one step
// at a time, and forward only. Nothing is skipped, and a failure does not rewind. A step that
// cannot be taken leaves the phase where it is, for the host to try again, which is what makes a
// destination's per-phase idempotence load-bearing rather than nice: a retry has to be safe, and
// this is what makes "retry" a phase instead of a restart.
//
// A phase names work that has **finished**, so `phase` is how far a move got:
//
//   created     the account exists at the destination for a DID it does not host, proved by the source
//   repo        the repo is there as a CAR (`sync.getRepo` -> `repo.importRepo`)
//   blobs       every blob the records reference is there, one at a time
//   prefs       private state is there — it does not ride the CAR, and a step with nothing to move is
//               a step that is done
//   space-meta  every space the account is the **authority** of landed as a meta archive
//               (`space.exportSpaceMeta` -> `space.importSpaceMeta`)
//   space-repos every space repo the account holds is there, with its blobs
//               (`space.getRepo` -> `space.importRepo`, then `space.listBlobs`/`space.getBlob` ->
//               `repo.uploadBlob`)
//   identity    the identity handover (`a34b`): the PLC operation, the rotation key, the handle
//   active      the account is live at the destination
//
// The spaces pair is **one step or two**, and it is two for a reason a single `spaces` phase would
// lose. The release pins a hard order — a space's meta before the account's repo in that space, or
// `importRepo` answers `SpaceNotFound` — and a phase boundary is the only thing that makes that
// order structural rather than a loop's discipline. It also makes the retry match the work: a move
// that fails importing the third space's repo resumes at `space-meta` and re-imports repos without
// re-exporting and re-importing every authority's meta archive, which is the only part of the pair
// that is pure transfer. `advanced` is then seven for a spaces move, and the five it always was for
// one without: `spaces` says whether this account has any, and a move with none skips both phases
// (`NoSpacesStaysFive` is the invariant that keeps that promise).
//
// Deliberately **not** phases: the agreement check afterwards (`checkAccountStatus` against the
// source) reads both sides rather than moving anything, and deactivating the source is the
// operator's decision once the account is live here (`1ubx`'s steps 6 and 9).
module pds_account_move {
  var phase: str // "created" | "repo" | "blobs" | "prefs" | "space-meta" | "space-repos" | "identity" | "active"
  var advanced: int // how many steps have been taken: how far along the sequence the phase is
  var spaces: bool // whether the account has any space data to carry at all
  var discovered: bool // whether the source has answered `listSpaces` yet

  action init = all {
    phase' = "created",
    advanced' = 0,
    spaces' = false,
    discovered' = false
  }

  // Discovery is the one fact the order depends on, and it happens before the first step: the source
  // answers `source.listSpaces` before anything is written. Both values are legal moves, so it is a
  // draw — and an `advance` drawn before it is a step that did not happen (see `canAdvance`).
  action discover = {
    nondet hasSpaces = Set(true, false).oneOf()
    all {
      phase' = phase,
      advanced' = advanced,
      // Asked once, and before any step: a later draw changes nothing, so a trace cannot discover
      // spaces into a move that already took the branch without them.
      spaces' = if (discovered) spaces else hasSpaces,
      discovered' = true
    }
  }

  // A draw of which phase to move to; `canAdvance` decides whether it happens.
  action advance = {
    nondet target = Set("repo", "blobs", "prefs", "space-meta", "space-repos", "identity", "active").oneOf()
    all {
      phase' = if (canAdvance(phase, target, spaces, discovered)) target else phase,
      advanced' = if (canAdvance(phase, target, spaces, discovered)) advanced + 1 else advanced,
      spaces' = spaces,
      discovered' = discovered
    }
  }

  action step = any { init, discover, advance }

  // One step at a time, and forward only, and only after discovery. This is the whole rule, and it is
  // a `def` so the spec and the hand-written machine read the same one. (`to` is a Quint built-in,
  // hence `before`/`after`.)
  //
  // The only branch is at `prefs`: an account with spaces takes two steps more than one without, and
  // the two meet again at `identity`, which stays after all of it — a space host follows the
  // authority through its DID document (`#atproto_pds`), so it can only follow the handover, never
  // lead it.
  def canAdvance(before: str, after: str, hasSpaces: bool, knewSpaces: bool): bool =
    knewSpaces and (
      (before == "created" and after == "repo")
      or (before == "repo" and after == "blobs")
      or (before == "blobs" and after == "prefs")
      or (before == "prefs" and hasSpaces and after == "space-meta")
      or (before == "prefs" and not(hasSpaces) and after == "identity")
      or (before == "space-meta" and after == "space-repos")
      or (before == "space-repos" and after == "identity")
      or (before == "identity" and after == "active")
    )

  val PhaseKnown: bool = or(
    phase == "created",
    phase == "repo",
    phase == "blobs",
    phase == "prefs",
    phase == "space-meta",
    phase == "space-repos",
    phase == "identity",
    phase == "active"
  )
  // Seven steps from the start to the end when there are spaces, five when there are none, and no
  // more: a move that took eight moved backwards, or skipped, which `canAdvance` says cannot happen.
  val AdvancedAtMostSeven: bool = advanced <= 7
  // Nothing has advanced if and only if nothing has happened.
  val AdvancedImpliesStarted: bool = or(advanced == 0, phase != "created")
  // And nothing advances before the source has said whether it has spaces to carry.
  val AdvancedImpliesDiscovered: bool = or(advanced == 0, discovered)
  // An account without spaces moves in exactly the five steps it always did: the spaces pair is not
  // a step that happens and finds nothing, it is a pair of steps that does not happen at all.
  val NoSpacesStaysFive: bool = or(spaces, advanced <= 5)
  // And the other direction: a spaces phase is a phase of a spaces move.
  val SpacesPhasesNeedSpaces: bool =
    or(spaces, and(phase != "space-meta", phase != "space-repos"))
  // The last step lands on the end, and the account is live only there.
  val ActiveIsTheLastStep: bool = or(
    phase != "active",
    advanced == (if (spaces) 7 else 5)
  )
}
