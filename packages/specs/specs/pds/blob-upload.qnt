// PDS blob upload lifecycle.
//
// A blob upload session starts empty, accepts chunks while uploading, and
// finalizes to an uploaded blob. A chunk that would exceed the size limit
// fails the session and discards the bytes; a failed session can only be
// discarded, never finalized. `discard` returns to empty from any phase.
module pds_blob_upload {
  var phase: str  // "empty" | "uploading" | "uploaded" | "failed"
  var bytes: int  // bytes accepted so far (0 unless uploading/uploaded)
  var limit: int  // configured maximum blob size

  // the incoming chunk would push the upload over the limit
  def exceeds(bytes: int, chunk: int, limit: int): bool =
    (bytes + chunk) > limit

  action init = all {
    phase' = "empty",
    bytes' = 0,
    limit' = 1024
  }

  action begin = all {
    phase' = if (phase == "empty") "uploading" else phase,
    bytes' = bytes,
    limit' = limit
  }

  // Append a chunk. Exceeding the limit fails the session and drops the bytes;
  // chunks are only accepted while uploading.
  action appendChunk = {
    nondet chunk = Set(0, 128, 1024, 2048).oneOf()
    all {
      phase' = if (phase == "uploading") (
        if (exceeds(bytes, chunk, limit)) "failed" else "uploading"
      ) else phase,
      bytes' = if (phase == "uploading") (
        if (exceeds(bytes, chunk, limit)) 0 else bytes + chunk
      ) else bytes,
      limit' = limit
    }
  }

  // Finalize: only an uploading session with bytes becomes an uploaded blob.
  action finish = all {
    phase' = if (phase == "uploading" and bytes > 0) "uploaded" else phase,
    bytes' = bytes,
    limit' = limit
  }

  // Discard the session/blob and return to empty.
  action discard = all {
    phase' = "empty",
    bytes' = 0,
    limit' = limit
  }

  action step = any { init, begin, appendChunk, finish, discard }

  val PhaseValid: bool = or(
    phase == "empty",
    phase == "uploading",
    phase == "uploaded",
    phase == "failed"
  )
  val LimitPositive: bool = limit > 0
  val BytesInRange: bool = and(bytes >= 0, bytes <= limit)
  // An uploaded blob always carries at least one byte.
  val UploadedNonEmpty: bool = or(phase != "uploaded", bytes > 0)
  // A failed upload never retains bytes.
  val FailedDiscardsBytes: bool = or(phase != "failed", bytes == 0)
}
