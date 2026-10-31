// PDS repo write path: record CAS against the current commit.
//
// A client submits a record write carrying the commit it observed
// (`swapCommit`). The PDS validates (CAS) the write, then commits: it applies
// the staged record, rebuilds the MST root and advances the repo commit. A
// stale observed commit is rejected as a conflict and leaves the repo
// untouched, so the client must refetch (`reload`) and retry.
module pds_repo_write {
  var phase: str      // "idle" | "validated" | "committed" | "conflict"
  var commit: int     // current repo commit sequence (ordinal of the commit)
  var record: int     // current record id, -1 when absent
  var staged: int     // record id prepared for the next commit, -1 when none
  var mstDirty: bool  // the MST root is recomputed but not yet committed

  action init = all {
    phase' = "idle",
    commit' = 0,
    record' = -1,
    staged' = -1,
    mstDirty' = false
  }

  // Submit a write with the commit the client observed:
  //   seen == -1       -> no swapCommit supplied, always validated
  //   seen == commit   -> CAS hit, validated
  //   otherwise        -> stale commit, conflict (pending write dropped)
  action submit = {
    nondet seen = Set(-1, 0, 1, 2, 3, 4).oneOf()
    all {
      phase' = if (seen == -1 or seen == commit) "validated" else "conflict",
      commit' = commit,
      record' = record,
      staged' = if (seen == -1 or seen == commit) commit + 1 else -1,
      mstDirty' = if (seen == -1 or seen == commit) true else false
    }
  }

  // Commit the validated write: apply the staged record and advance commit.
  // With nothing staged (staged == -1) it is a no-op, never rewinding commit.
  action commitWrite = all {
    phase' = if (staged >= 0) "committed" else phase,
    commit' = if (staged >= 0) staged else commit,
    record' = if (staged >= 0) staged else record,
    staged' = staged,
    mstDirty' = false
  }

  // After a conflict the client refetches the commit and clears the conflict.
  action reload = all {
    phase' = "idle",
    commit' = commit,
    record' = record,
    staged' = -1,
    mstDirty' = false
  }

  action step = any { init, submit, commitWrite, reload }

  val CommitNonNegative: bool = commit >= 0
  val RecordInRange: bool = and(record >= -1, record <= commit)
  val StagedInRange: bool = and(staged >= -1, staged <= commit + 1)
  val PhaseValid: bool = or(
    phase == "idle",
    phase == "validated",
    phase == "committed",
    phase == "conflict"
  )
  // A validated write always has its next record staged and the MST dirty.
  val ValidatedStaged: bool = or(
    phase != "validated",
    and(staged == commit + 1, mstDirty == true)
  )
  // The MST may only be dirty while a write is validated, never after commit.
  val DirtyOnlyWhenValidated: bool = or(
    mstDirty == false,
    phase == "validated"
  )
}
