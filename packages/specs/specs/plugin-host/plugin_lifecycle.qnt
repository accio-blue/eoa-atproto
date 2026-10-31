// Plugin host: plugin lifecycle + signed-manifest escalation gate.
//
// The host runs ONE ISOLATE per plugin; the manifest is the security
// boundary (deny-by-default). A plugin installs (isolate allocated, declared
// manifest), activates, and may request a capability escalation. That
// escalation widens the manifest ONLY after the signed-manifest gate
// approves it; rejection leaves the declared manifest in place. Uninstall
// tears the isolate down.
//
// The spec is the source of truth; the generated model document drives the
// spec-only verification (test/plugin-host/plugin_lifecycle.test.ts).
module plugin_lifecycle {
  var status: str      // "uninstalled" | "installed" | "active"
  var manifest: str    // "none" | "declared" | "widened"
  var gate: str        // "closed" | "pending" | "approved" | "rejected"
  var isolate: str     // "none" | "allocated"
  var requested: str   // "none" | "read" | "write"

  action init = all {
    status' = "uninstalled",
    manifest' = "none",
    gate' = "closed",
    isolate' = "none",
    requested' = "none"
  }

  action install = all {
    status' = if (status == "uninstalled") "installed" else status,
    manifest' = if (status == "uninstalled") "declared" else manifest,
    isolate' = if (status == "uninstalled") "allocated" else isolate,
    gate' = gate,
    requested' = requested
  }

  action activate = all {
    status' = if (status == "installed" and manifest == "declared") "active" else status,
    manifest' = manifest,
    isolate' = isolate,
    gate' = gate,
    requested' = requested
  }

  // request a capability escalation: moves the gate to pending, but does not
  // widen the manifest itself
  action escalate = {
    nondet scope = Set("read", "write").oneOf()
    all {
      status' = status,
      manifest' = manifest,
      isolate' = isolate,
      gate' = if (status == "active" and manifest == "declared") "pending" else gate,
      requested' = if (status == "active" and manifest == "declared") scope else requested
    }
  }

  // the signed-manifest gate approves: only now does the manifest widen
  action approve = all {
    status' = status,
    manifest' = if (gate == "pending") "widened" else manifest,
    isolate' = isolate,
    gate' = if (gate == "pending") "approved" else gate,
    requested' = requested
  }

  action reject = all {
    status' = status,
    manifest' = manifest,
    isolate' = isolate,
    gate' = if (gate == "pending") "rejected" else gate,
    requested' = requested
  }

  action uninstall = all {
    status' = "uninstalled",
    manifest' = "none",
    isolate' = "none",
    gate' = "closed",
    requested' = "none"
  }

  action step = any { init, install, activate, escalate, approve, reject, uninstall }

  // a widened manifest exists only behind an approved gate
  val NoEscalationWithoutGate: bool =
    or(manifest != "widened", gate == "approved")

  // one isolate per plugin: allocated exactly when the plugin is resident
  val IsolateBound: bool =
    or(
      and(status == "uninstalled", isolate == "none"),
      and(status != "uninstalled", isolate == "allocated")
    )

  val StatusValid: bool =
    or(status == "uninstalled", status == "installed", status == "active")

  val RequestedValid: bool =
    or(requested == "none", requested == "read", requested == "write")
}
