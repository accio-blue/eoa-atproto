// IMAP — the session state machine, and the promise a client's cache is built on.
//
// RFC 3501 is mostly one state machine: not-authenticated → authenticated →
// selected → logout, with each command legal in exactly one of them. Getting that
// wrong is not a style problem — a `FETCH` before `SELECT` is a client talking to
// a mailbox it has not opened.
//
// The second thing here is the part clients actually *trust*:
//
//   * a UID, once assigned, is never reassigned — `uidNext` only ever moves past
//     what has been handed out, so a cached UID cannot come to mean another
//     message;
//   * a UID that was served is one that existed;
//   * and `SELECT` is what opens a mailbox, so nothing is served before it.
//
// This is the read-only half: listing, selecting (and examining, which is the
// same open for a client that wants it read-only) and fetching. STORE, EXPUNGE,
// APPEND and IDLE change what is in the mailbox, and they belong in their own
// machine rather than being bolted onto this one.
module mail_imap_session {
  var state: str // "not-authenticated" | "authenticated" | "selected" | "logout"
  var selected: str // the mailbox name, "none" before SELECT
  var everSelected: bool // a mailbox was opened at some point (never cleared)
  var uidNext: int // the next UID to assign
  var assignedMax: int // the highest UID ever assigned (0 = none)
  var lastUid: int // the UID of the last message served (0 = none)
  var lastOutcome: str // "none" | "ok" | "no" — the tagged completion

  def hasServed: bool = lastUid > 0
  def inSelected: bool = state == "selected"
  def canLogin: bool = state == "not-authenticated"
  // RFC 3501 6.3.1: SELECT is valid in the authenticated *and* the selected
  // state. A client re-opens a mailbox to refresh it, and refusing that is a
  // client that cannot see new mail — which is how `imaplib` found it.
  def canSelect: bool = or(state == "authenticated", state == "selected")

  action init = all {
    state' = "not-authenticated",
    selected' = "none",
    everSelected' = false,
    uidNext' = 1,
    assignedMax' = 0,
    lastUid' = 0,
    lastOutcome' = "none",
  }

  action login = {
    nondet ok = Set(true, false).oneOf()
    all {
      state' = if (and(canLogin, ok)) "authenticated" else state,
      selected' = selected,
      everSelected' = everSelected,
      uidNext' = uidNext,
      assignedMax' = assignedMax,
      lastUid' = lastUid,
      lastOutcome' = if (canLogin) if (ok) "ok" else "no" else "no",
    }
  }

  action openMailbox = {
    nondet ok = Set(true, false).oneOf()
    all {
      state' = if (and(canSelect, ok)) "selected" else state,
      selected' = if (and(canSelect, ok)) "INBOX" else selected,
      everSelected' = if (and(canSelect, ok)) true else everSelected,
      uidNext' = uidNext,
      assignedMax' = assignedMax,
      lastUid' = lastUid,
      lastOutcome' = if (canSelect) if (ok) "ok" else "no" else "no",
    }
  }

  // EXAMINE: SELECT for a client that wants it read-only. The same transition —
  // this face is read-only either way — and it is here because a *real* client
  // sends it: `imaplib` uses EXAMINE whenever it is asked for a read-only
  // mailbox, and answering BAD is a client that cannot open the mail at all.
  action examine = {
    nondet ok = Set(true, false).oneOf()
    all {
      state' = if (and(canSelect, ok)) "selected" else state,
      selected' = if (and(canSelect, ok)) "INBOX" else selected,
      everSelected' = if (and(canSelect, ok)) true else everSelected,
      uidNext' = uidNext,
      assignedMax' = assignedMax,
      lastUid' = lastUid,
      lastOutcome' = if (canSelect) if (ok) "ok" else "no" else "no",
    }
  }

  action fetch = {
    nondet ok = Set(true, false).oneOf()
    all {
      state' = state,
      selected' = selected,
      everSelected' = everSelected,
      uidNext' = uidNext,
      assignedMax' = assignedMax,
      // Only a selected session is served, and only a UID that was assigned.
      lastUid' = if (and(inSelected, ok)) assignedMax else lastUid,
      lastOutcome' = if (inSelected) if (ok) "ok" else "no" else "no",
    }
  }

  // A message arrives: it takes the next UID, and the counter moves past it.
  action deliver = all {
    state' = state,
    selected' = selected,
    everSelected' = everSelected,
    uidNext' = uidNext + 1,
    assignedMax' = uidNext,
    lastUid' = lastUid,
    lastOutcome' = lastOutcome,
  }

  action noop = all {
    state' = state,
    selected' = selected,
    everSelected' = everSelected,
    uidNext' = uidNext,
    assignedMax' = assignedMax,
    lastUid' = lastUid,
    lastOutcome' = "ok",
  }

  action logout = all {
    state' = "logout",
    selected' = selected,
    everSelected' = everSelected,
    uidNext' = uidNext,
    assignedMax' = assignedMax,
    lastUid' = lastUid,
    lastOutcome' = "ok",
  }

  action step = any {
    init,
    login,
    openMailbox,
    examine,
    fetch,
    deliver,
    noop,
    logout,
  }

  val StateValid: bool = or(
    state == "not-authenticated",
    state == "authenticated",
    state == "selected",
    state == "logout"
  )
  // Nothing is served before a mailbox is opened. "Was served" is a fact about
  // history, so the invariant needs a monotone witness for it — a flag that is
  // set once and never cleared — rather than the current state, which a LOGOUT
  // legitimately leaves.
  val NoFetchBeforeSelect: bool = or(not(hasServed), everSelected)
  // The next UID is past everything handed out: a UID is never reused.
  val UidNextAboveAssigned: bool = uidNext > assignedMax
  // And a served UID is one that existed.
  val ServedWasAssigned: bool = or(not(hasServed), lastUid <= assignedMax)
  // A selected session is one with a mailbox.
  val SelectedHasMailbox: bool = or(not(inSelected), not(selected == "none"))
}
