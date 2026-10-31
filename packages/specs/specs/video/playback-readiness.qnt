// Video service: playback readiness as seen by a viewer.
//
// Once a transcode job publishes its HLS playlist the video goes live and
// playback requests are served; before publication the endpoint answers
// "not ready", and after the video is deleted (or its artifacts expire) it is
// gone and playback stops. This is the consumer-facing counterpart to the
// producer-side job lifecycle (`specs/video/transcode-job.qnt`): it models what
// a playback request observes, not how transcoding runs.
//
// The generator's subset has no action guards, so every action only takes
// effect in its own phase via `if (<phase>) new else current`.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/video/playback-readiness.test.ts).
module video_playback_readiness {
  var stage: str    // "processing" | "playable" | "gone"
  var requests: int // playback requests received
  var served: int   // requests answered with the playlist
  var blocked: int  // requests answered not-ready or gone

  def isPlayable(now: str): bool = now == "playable"

  // A video that is gone never comes back; readiness is one-way.
  def isGone(now: str): bool = now == "gone"

  action init = all {
    stage' = "processing",
    requests' = 0,
    served' = 0,
    blocked' = 0
  }

  // The transcode job published the playlist: the video becomes playable.
  action publish = all {
    stage' = if (stage == "processing") "playable" else stage,
    requests' = requests,
    served' = served,
    blocked' = blocked
  }

  // A playback request: served only while the video is playable, otherwise
  // answered as unavailable (still processing, or gone).
  action request = all {
    stage' = stage,
    requests' = requests + 1,
    served' = if (isPlayable(stage)) served + 1 else served,
    blocked' = if (isPlayable(stage)) blocked else blocked + 1
  }

  // The video is deleted or its artifacts expire: playback stops for good.
  action remove = all {
    stage' = if (isGone(stage)) stage else "gone",
    requests' = requests,
    served' = served,
    blocked' = blocked
  }

  action step = any { init, publish, request, remove }

  val StageValid: bool = or(
    stage == "processing", stage == "playable", stage == "gone"
  )
  val CountersNonNegative: bool = and(
    requests >= 0, served >= 0, blocked >= 0
  )
  // Every request is accounted for exactly once — served or blocked.
  val RequestsBacked: bool = requests == served + blocked
  val ServedBound: bool = served <= requests
  // Nothing is served before the playlist is published; once `served` is
  // positive the video has left "processing" for good.
  val ServedImpliesPublished: bool = or(served == 0, stage != "processing")
}
