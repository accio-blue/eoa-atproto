// Plugin host: the registry escalation gate for plugin upgrades.
//
// A plugin is published to the registry, versioned, with a signed manifest.
// On upgrade the capabilities are diffed. A NARROW upgrade takes the fast
// path straight to live. A WIDENED manifest is an escalation: it reaches
// live only after attestation recorded a valid signature and the gate
// approved — a missing or invalid signature never goes live widened.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/plugin-host/registry_gate.test.ts).
module registry_gate {
  var stage: str        // "idle" | "submitted" | "attested" | "live" | "rejected"
  var signature: str    // "missing" | "valid" | "invalid"
  var width: str        // "narrow" | "wide"

  action init = all {
    stage' = "idle",
    signature' = "missing",
    width' = "narrow"
  }

  action submit = {
    nondet scope = Set("narrow", "wide").oneOf()
    all {
      stage' = if (stage == "idle" or stage == "live" or stage == "rejected") "submitted" else stage,
      signature' = if (stage == "idle" or stage == "live" or stage == "rejected") "missing" else signature,
      width' = if (stage == "idle" or stage == "live" or stage == "rejected") scope else width
    }
  }

  // attestation records the signature verdict; it does not publish, and it
  // may re-attest so an invalid verdict is not a dead end
  action attest = {
    nondet sig = Set("valid", "invalid").oneOf()
    all {
      stage' = if (stage == "submitted" or stage == "attested") "attested" else stage,
      signature' = if (stage == "submitted" or stage == "attested") sig else signature,
      width' = width
    }
  }

  // fast path: a narrow manifest needs no escalation gate
  action publish = all {
    stage' = if (stage == "submitted" and width == "narrow") "live" else stage,
    signature' = signature,
    width' = width
  }

  // the gate: a widened manifest goes live only with a valid signature
  action approve = all {
    stage' = if (stage == "attested" and signature == "valid") "live" else stage,
    signature' = signature,
    width' = width
  }

  action reject = all {
    stage' = if (stage == "submitted" or stage == "attested") "rejected" else stage,
    signature' = signature,
    width' = width
  }

  action step = any { init, submit, attest, publish, approve, reject }

  // a live widened manifest implies a valid signed attestation
  val NoEscalationWithoutGate: bool =
    or(width != "wide", stage != "live", signature == "valid")

  val StageValid: bool =
    or(
      stage == "idle",
      stage == "submitted",
      stage == "attested",
      stage == "live",
      stage == "rejected"
    )

  val SignatureValid: bool =
    or(signature == "missing", signature == "valid", signature == "invalid")
}
