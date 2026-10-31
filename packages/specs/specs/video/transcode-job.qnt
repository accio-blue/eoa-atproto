// Video service: the transcode job lifecycle.
//
// The video service receives an admitted source video and runs a transcode job
// over it: the job is queued, a worker starts it and reports progress, and it
// ends either ready (the HLS playlist is published and the video is
// playback-ready) or failed (retryable). The raw upload itself is a blob/PDS
// concern (`specs/pds/blob-upload.qnt`, `specs/blob-media/*`) and is
// intentionally not repeated here; this machine starts from an already-admitted
// job.
//
// The generator's subset has no action guards, so every action only takes
// effect in its own phase via `if (<phase>) new else current`. Bare zero-arg
// def names are not resolved by the runtime evaluator, so every def takes the
// values it reads as parameters.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/video/transcode-job.test.ts).
module video_transcode_job {
  var stage: str    // "queued" | "running" | "ready" | "failed"
  var attempts: int // worker attempts started (first try + retries)
  var failures: int // attempts that ended in failure
  var progress: int // transcode progress, 0..100 (100 only when ready)
  var playlist: bool // the HLS playlist artifact is published (playable)

  def isReady(now: str): bool = now == "ready"

  // A brand-new job or one that failed can be picked up by a worker.
  def retryable(now: str): bool = or(now == "queued", now == "failed")

  // Progress advances only while running, and never reaches 100 on its own:
  // `finish` publishes the playlist at exactly 100.
  def canAdvance(now: str, current: int, inc: int): bool =
    and(now == "running", current + inc < 100)

  // Playback readiness: the job is ready and the playlist is published.
  def playable(now: str, hasPlaylist: bool): bool = and(isReady(now), hasPlaylist)

  action init = all {
    stage' = "queued",
    attempts' = 0,
    failures' = 0,
    progress' = 0,
    playlist' = false
  }

  // A worker picks the job up: the first attempt from queued, or a retry after
  // a failure. A job that is already running/ready is left untouched.
  action start = all {
    stage' = if (retryable(stage)) "running" else stage,
    attempts' = if (retryable(stage)) attempts + 1 else attempts,
    failures' = failures,
    progress' = if (retryable(stage)) 0 else progress,
    playlist' = playlist
  }

  // The worker reports progress. Progress only ever advances while running and
  // never lands on 100 (that is `finish`).
  action advance = {
    nondet increment = Set(10, 25, 50).oneOf()
    all {
      stage' = stage,
      attempts' = attempts,
      failures' = failures,
      progress' = if (canAdvance(stage, progress, increment))
                    progress + increment
                  else progress,
      playlist' = playlist
    }
  }

  // Transcoding succeeded: the job is ready and the playlist is published, so
  // the video is playback-ready.
  action finish = all {
    stage' = if (stage == "running") "ready" else stage,
    attempts' = attempts,
    failures' = failures,
    progress' = if (stage == "running") 100 else progress,
    playlist' = if (stage == "running") true else playlist
  }

  // The attempt failed: the job is failed and retryable. Any partial progress
  // is dropped when it is requeued or retried.
  action abort = all {
    stage' = if (stage == "running") "failed" else stage,
    attempts' = attempts,
    failures' = if (stage == "running") failures + 1 else failures,
    progress' = progress,
    playlist' = playlist
  }

  // Requeue a failed job so a fresh attempt can run from a clean slate.
  action requeue = all {
    stage' = if (stage == "failed") "queued" else stage,
    attempts' = attempts,
    failures' = failures,
    progress' = if (stage == "failed") 0 else progress,
    playlist' = playlist
  }

  action step = any { init, start, advance, finish, abort, requeue }

  val StageValid: bool = or(
    stage == "queued", stage == "running", stage == "ready", stage == "failed"
  )
  val ProgressBound: bool = and(progress >= 0, progress <= 100)
  val ProgressZeroWhenQueued: bool = or(stage != "queued", progress == 0)
  val ProgressFullWhenReady: bool = or(stage != "ready", progress == 100)
  // A running job is never already at 100 — only `finish` crosses to ready.
  val RunningProgressIncomplete: bool = or(stage != "running", progress < 100)

  val AttemptsNonNegative: bool = attempts >= 0
  val FailuresNonNegative: bool = failures >= 0
  // Failures are a subset of attempts; a job cannot fail without being started.
  val FailuresWithinAttempts: bool = failures <= attempts
  val RunningImpliesAttempt: bool = or(stage != "running", attempts >= 1)

  // Playback readiness is derived, never staged: the playlist exists exactly
  // when the job is ready, and ready always means 100% + playlist.
  val ReadyImpliesPlaylist: bool = or(stage != "ready", playlist)
  val PlaylistImpliesReady: bool = or(not(playlist), isReady(stage))
  val ReadyIsPlayable: bool = or(stage != "ready", playable(stage, playlist))
}
