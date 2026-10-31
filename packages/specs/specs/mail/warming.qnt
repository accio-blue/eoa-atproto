// Warming and reputation — the rules that keep one member's bad day from becoming
// the pool's.
//
// A cooperative relay sends from a **shared** domain, which is the reason a small
// sender joins one at all: the domain's reputation is the pool's, and a domain with
// no history has none. That cuts both ways, and this machine is the half that
// protects everybody else. A new domain sends on a schedule — comail's numbers, 2
// an hour and 10 a day in week one, 10 an hour and 50 a day in week two — and a
// bounce or complaint rate over the threshold stops the *domain* rather than the
// member who caused it.
//
// The invariant that matters is the one the epic names: a domain cannot reach the
// higher tier by being impatient, and while it is paused it is silent.
//
// Guards live in the assignment RHS because the generator supports no action
// preconditions. `sentWhenPaused` is how a *guard* becomes an invariant: it records
// the total when the pause took effect, so a send that slips past a pause moves the
// total and breaks `PausedIsSilent` — which is the only way a state predicate can
// catch a guard that was edited away.
module mail_warming {
  var tier: str // "new" | "warmed"
  var week: int // how long the domain has been sending at all
  var day: int
  var sendsHour: int
  var sendsDay: int
  var sent: int // the 24h window, which is what the rates are about
  var delivered: int
  var bounces: int
  var complaints: int
  var paused: bool
  var sentWhenPaused: int // `sent` at the moment the pause took effect

  def hourlyCap: int = if (tier == "new") 2 else 10
  def dailyCap: int = if (tier == "new") 10 else 50

  // Paused, over the hour, or over the day: any one of them is a refusal.
  def canSend: bool = and(
    not(paused),
    and(sendsHour < hourlyCap, sendsDay < dailyCap)
  )

  // The thresholds, in integers: 5% of the window, and 8 in 10,000. Both need
  // something to be a *rate* of, so a window with nothing in it is not over.
  def bounceRateHigh(total: int, bad: int): bool = and(
    total > 0,
    bad * 100 >= total * 5
  )
  def complaintRateHigh(total: int, bad: int): bool = and(
    total > 0,
    bad * 10000 >= total * 8
  )

  // Whether this outcome, as it lands, crosses either threshold.
  def crosses(outcome: str, total: int, bounced: int, complained: int): bool = or(
    bounceRateHigh(total + 1, bounced + (if (outcome == "bounced") 1 else 0)),
    complaintRateHigh(total + 1, complained + (if (outcome == "complained") 1 else 0))
  )

  action init = all {
    tier' = "new",
    week' = 1,
    day' = 1,
    sendsHour' = 0,
    sendsDay' = 0,
    sent' = 0,
    delivered' = 0,
    bounces' = 0,
    complaints' = 0,
    paused' = false,
    sentWhenPaused' = 0,
  }

  // One message leaves. The recipient's system answers, and a complaint is not an
  // answer about this message alone: it is a person deciding about it.
  action send = {
    nondet outcome = Set("delivered", "bounced", "complained").oneOf()
    all {
      sendsHour' = if (canSend) sendsHour + 1 else sendsHour,
      sendsDay' = if (canSend) sendsDay + 1 else sendsDay,
      sent' = if (canSend) sent + 1 else sent,
      delivered' = if (and(canSend, outcome == "delivered"))
        delivered + 1
      else delivered,
      bounces' = if (and(canSend, outcome == "bounced"))
        bounces + 1
      else bounces,
      complaints' = if (and(canSend, outcome == "complained"))
        complaints + 1
      else complaints,
      // Checked against the counters as they now stand, not the ones before this
      // message: the threshold the sender crossed is the one this message crossed.
      paused' = if (canSend)
        crosses(outcome, sent, bounces, complaints)
      else paused,
      sentWhenPaused' = if (and(canSend, crosses(outcome, sent, bounces, complaints)))
        sent + 1
      else sentWhenPaused,
      tier' = tier,
      week' = week,
      day' = day,
    }
  }

  // An hour of nothing: the hourly allowance is a rate, not a total.
  action advanceHour = all {
    sendsHour' = 0,
    tier' = tier,
    week' = week,
    day' = day,
    sendsDay' = sendsDay,
    sent' = sent,
    delivered' = delivered,
    bounces' = bounces,
    complaints' = complaints,
    paused' = paused,
    sentWhenPaused' = sentWhenPaused,
  }

  // A day of nothing: the window the rates are computed over rolls over. The pause
  // does **not** lift — a rate tells you something went wrong, and what went wrong
  // is somebody's to fix before the pool sends for them again.
  action advanceDay = all {
    day' = day + 1,
    sendsDay' = 0,
    sendsHour' = 0,
    sent' = 0,
    delivered' = 0,
    bounces' = 0,
    complaints' = 0,
    tier' = tier,
    week' = week,
    paused' = paused,
    sentWhenPaused' = sentWhenPaused,
  }

  // A week of sending, and the caps loosen. Early promotion cannot happen: the
  // guard is `day >= 7`, and `PromotedNotEarly` is that guard as a predicate.
  action promote = all {
    tier' = if (and(tier == "new", day >= 7)) "warmed" else tier,
    week' = if (and(tier == "new", day >= 7)) 2 else week,
    day' = day,
    sendsHour' = sendsHour,
    sendsDay' = sendsDay,
    sent' = sent,
    delivered' = delivered,
    bounces' = bounces,
    complaints' = complaints,
    paused' = paused,
    sentWhenPaused' = sentWhenPaused,
  }

  // Somebody looked at what went wrong. The only way out of a pause, because the
  // only thing that can honestly lift one is a person who knows why it happened.
  action resume = all {
    paused' = false,
    sentWhenPaused' = sent,
    tier' = tier,
    week' = week,
    day' = day,
    sendsHour' = sendsHour,
    sendsDay' = sendsDay,
    sent' = sent,
    delivered' = delivered,
    bounces' = bounces,
    complaints' = complaints,
  }

  action step = any { init, send, advanceHour, advanceDay, promote, resume }

  val WithinHourlyCap: bool = sendsHour <= hourlyCap
  val WithinDailyCap: bool = sendsDay <= dailyCap
  // A pause is not a sentiment: nothing leaves while it is on. The witness is what
  // makes a *guard* a checkable state — a send that slipped past one moves `sent`
  // and this is the predicate that notices.
  val PausedIsSilent: bool = or(not(paused), sent <= sentWhenPaused)
  // And the higher tier is earned by time, not by wanting it.
  val PromotedNotEarly: bool = or(not(tier == "warmed"), day >= 7)
}
