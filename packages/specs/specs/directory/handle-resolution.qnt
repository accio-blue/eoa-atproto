// Handle resolution as a behavior-machine.
//
// Behavior: DNS TXT at `_atproto.<handle>` is tried first; when it yields no
// DID (absent record OR a transport failure, both observable as "missing") the
// HTTPS `/.well-known/atproto-did` document is the fallback. The resolved DID
// document must then claim the handle in `alsoKnownAs`, otherwise the binding
// is rejected. Mirrors packages/identity/src/handle-resolution.ts.
//
// The generator's subset has no action guards, so each lookup only takes effect
// in its phase via `if (phase == ...) new else current`.
module handle_resolution {
  var phase: str       // idle | well-known | verifying | resolved | unresolved | mismatch
  var source: str      // "none" | "dns" | "well-known"
  var handle: str      // the requested handle
  var dns: str         // "none" | "missing" | "did:plc:alice" | "did:plc:other"
  var wellKnown: str   // "none" | "missing" | "did:plc:alice" | "did:plc:other"
  var resolvedDid: str // "none" | "did:plc:alice" | "did:plc:other"
  var docHandle: str   // the document's claim: "none" | "alice.example.com" | "bob.example.com"

  action init = all {
    phase' = "idle",
    source' = "none",
    handle' = "alice.example.com",
    dns' = "none",
    wellKnown' = "none",
    resolvedDid' = "none",
    docHandle' = "none"
  }

  action dnsLookup = {
    nondet result = Set("did:plc:alice", "did:plc:other", "missing").oneOf()
    all {
      phase' = if (phase == "idle")
                 (if (result == "missing") "well-known" else "verifying")
               else phase,
      source' = if (phase == "idle" and result != "missing") "dns" else source,
      handle' = handle,
      dns' = if (phase == "idle") result else dns,
      wellKnown' = wellKnown,
      resolvedDid' = if (phase == "idle" and result != "missing") result else resolvedDid,
      docHandle' = docHandle
    }
  }

  action wellKnownLookup = {
    nondet result = Set("did:plc:alice", "did:plc:other", "missing").oneOf()
    all {
      phase' = if (phase == "well-known")
                 (if (result == "missing") "unresolved" else "verifying")
               else phase,
      source' = if (phase == "well-known" and result != "missing") "well-known" else source,
      handle' = handle,
      dns' = dns,
      wellKnown' = if (phase == "well-known") result else wellKnown,
      resolvedDid' = if (phase == "well-known" and result != "missing") result else resolvedDid,
      docHandle' = docHandle
    }
  }

  action verify = {
    nondet claim = Set("alice.example.com", "bob.example.com", "none").oneOf()
    all {
      phase' = if (phase == "verifying")
                 (if (claim == handle) "resolved" else "mismatch")
               else phase,
      source' = source,
      handle' = handle,
      dns' = dns,
      wellKnown' = wellKnown,
      resolvedDid' = resolvedDid,
      docHandle' = if (phase == "verifying") claim else docHandle
    }
  }

  action step = any { init, dnsLookup, wellKnownLookup, verify }

  // A resolved handle names a DID and the source that produced it.
  val HandleResolves: bool =
    if (phase == "resolved")
      resolvedDid != "none" and source != "none"
    else true

  val SourceValid: bool =
    source == "none" or source == "dns" or source == "well-known"

  // Well-known is a FALLBACK: it is only ever the source after DNS came up
  // empty, never while DNS returned a DID.
  val DnsBeforeWellKnown: bool =
    if (source == "well-known") dns == "missing" else true

  val PhaseValid: bool =
    phase == "idle" or phase == "well-known" or phase == "verifying" or
    phase == "resolved" or phase == "unresolved" or phase == "mismatch"
}
