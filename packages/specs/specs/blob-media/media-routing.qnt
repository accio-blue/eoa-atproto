// Blob/media service: media-request routing.
//
// A media request names a derivative variant and is resolved against where it
// can be answered from: a warm cached variant is served from cache, a cold but
// derivable variant is derived locally, and a variant only available at the
// origin is redirected. An unknown variant is rejected. The route is decided
// before the response, and each request is delivered exactly once.
//
// The generator's subset has no action guards, so each action only takes effect
// in its own phase via `if (phase == ...) new else current`.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/blob-media/media-routing.test.ts).
module blob_media_media_routing {
  var phase: str        // "idle" | "routing" | "resolved" | "served" | "redirected" | "rejected"
  var requested: str    // "none" | "thumb" | "feed" | "full" | "unknown"
  var availability: str // "none" | "hot" | "cold" | "remote"
  var route: str        // "none" | "cache" | "derive" | "origin" | "reject"
  var served: int
  var redirected: int
  var rejected: int

  // A local response is either a cache hit or a fresh derivation.
  def isLocal(want: str): bool = or(want == "cache", want == "derive")

  action init = all {
    phase' = "idle",
    requested' = "none",
    availability' = "none",
    route' = "none",
    served' = 0,
    redirected' = 0,
    rejected' = 0
  }

  // Accept a media request naming one variant.
  action accept = {
    nondet pick = Set("thumb", "feed", "full", "unknown").oneOf()
    all {
      phase' = if (phase == "idle") "routing" else phase,
      requested' = if (phase == "idle") pick else requested,
      availability' = availability,
      route' = route,
      served' = served,
      redirected' = redirected,
      rejected' = rejected
    }
  }

  // Probe where the requested variant can be answered from and decide the route.
  action probe = {
    nondet found = Set("hot", "cold", "remote").oneOf()
    all {
      phase' = if (phase == "routing") "resolved" else phase,
      requested' = requested,
      availability' = if (phase == "routing") found else availability,
      route' = if (phase == "routing") (
        if (requested == "unknown") "reject"
        else if (found == "hot") "cache"
        else if (found == "cold") "derive"
        else "origin"
      ) else route,
      served' = served,
      redirected' = redirected,
      rejected' = rejected
    }
  }

  // Deliver the resolved response exactly once.
  action deliver = all {
    phase' = if (phase == "resolved") (
      if (isLocal(route)) "served"
      else if (route == "origin") "redirected"
      else "rejected"
    ) else phase,
    requested' = requested,
    availability' = availability,
    route' = route,
    served' = if (phase == "resolved" and isLocal(route)) served + 1 else served,
    redirected' = if (phase == "resolved" and route == "origin")
                    redirected + 1
                  else redirected,
    rejected' = if (phase == "resolved" and route == "reject")
                  rejected + 1
                else rejected
  }

  // Return to idle for the next request.
  action reset = all {
    phase' = if (phase == "served" or phase == "redirected" or phase == "rejected")
               "idle"
             else phase,
    requested' = if (phase == "served" or phase == "redirected" or phase == "rejected")
                   "none"
                 else requested,
    availability' = if (phase == "served" or phase == "redirected" or phase == "rejected")
                      "none"
                    else availability,
    route' = if (phase == "served" or phase == "redirected" or phase == "rejected")
               "none"
             else route,
    served' = served,
    redirected' = redirected,
    rejected' = rejected
  }

  action step = any { init, accept, probe, deliver, reset }

  val PhaseValid: bool = or(
    phase == "idle", phase == "routing", phase == "resolved",
    phase == "served", phase == "redirected", phase == "rejected"
  )
  val RouteValid: bool = or(
    route == "none", route == "cache", route == "derive",
    route == "origin", route == "reject"
  )
  val CountersNonNegative: bool = and(
    served >= 0, redirected >= 0, rejected >= 0
  )
  // A resolved request always names a route.
  val ResolvedHasRoute: bool = or(phase != "resolved", route != "none")
  // An idle request never carries a route.
  val IdleHasNoRoute: bool = or(phase != "idle", route == "none")
  // Serving is always a cache hit or a derivation, never an origin redirect.
  val ServedLocally: bool = or(phase != "served", isLocal(route))
  // Only an unknown variant is ever rejected.
  val RejectOnlyUnknown: bool = or(phase != "rejected", requested == "unknown")
}
