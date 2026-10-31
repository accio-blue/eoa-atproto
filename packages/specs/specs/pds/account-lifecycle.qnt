// PDS account lifecycle.
//
// An account is created only when its handle is free, activating to a live
// account. It can be suspended and reinstated, and deleted from either live
// state. Deleting releases the handle; a deleted account is terminal, since
// creation requires the absent state.
module pds_account_lifecycle {
  var status: str          // "absent" | "created" | "active" | "suspended" | "deleted"
  var handleReserved: bool // this account currently holds its handle

  action init = all {
    status' = "absent",
    handleReserved' = false
  }

  // Register an account. A taken handle rejects registration (stays absent).
  action create = {
    nondet availability = Set("free", "taken").oneOf()
    all {
      status' = if (status == "absent" and availability == "free") "created" else status,
      handleReserved' = if (status == "absent" and availability == "free") true else handleReserved
    }
  }

  action activate = all {
    status' = if (status == "created") "active" else status,
    handleReserved' = handleReserved
  }

  action suspend = all {
    status' = if (status == "active") "suspended" else status,
    handleReserved' = handleReserved
  }

  action reinstate = all {
    status' = if (status == "suspended") "active" else status,
    handleReserved' = handleReserved
  }

  // Delete a live account; the handle is released for reuse.
  action deleteAccount = all {
    status' = if (status == "active" or status == "suspended") "deleted" else status,
    handleReserved' = if (status == "active" or status == "suspended") false else handleReserved
  }

  action step = any { init, create, activate, suspend, reinstate, deleteAccount }

  val StatusValid: bool = or(
    status == "absent",
    status == "created",
    status == "active",
    status == "suspended",
    status == "deleted"
  )
  // Every existing account (created/active/suspended) holds its handle.
  val CreatedReservesHandle: bool = or(status != "created", handleReserved == true)
  val ActiveReservesHandle: bool = or(status != "active", handleReserved == true)
  val SuspendedReservesHandle: bool = or(status != "suspended", handleReserved == true)
  // Absent and deleted accounts hold no handle.
  val AbsentHasNoHandle: bool = or(status != "absent", handleReserved == false)
  val DeletedReleasesHandle: bool = or(status != "deleted", handleReserved == false)
}
