// DID-document derivation as a behavior-machine.
//
// Behavior: the directory renders a document from the HEAD operation only. The
// `id` is the account, `alsoKnownAs` is the claimed handle, the `#atproto`
// verification method comes from the signing key, `#atproto_pds` from the PDS
// endpoint - and rotation keys NEVER appear in the document. A tombstone (or no
// head) withholds the document. Mirrors renderDocument in
// packages/identity/src/plc-operation.ts.
//
// `docEpoch` records which head the document was rendered for, so "stale
// document" and "document disagrees with its head" are distinguishable: the
// consistency invariant only bites when the epochs match.
module did_doc_derivation {
  var headKind: str        // "none" | "plc_operation" | "plc_tombstone"
  var headSigningKey: str  // "none" | "sigA" | "sigB"
  var headHandle: str      // "none" | "alice.example.com" | "bob.example.com"
  var headPds: str         // "none" | "pds.one" | "pds.two"
  var headEpoch: int       // bumps whenever a head is installed
  var docEpoch: int        // the head epoch the document was rendered for
  var docRendered: bool
  var docId: str           // "none" | "did:plc:genesis"
  var docAlias: str
  var docKey: str
  var docService: str
  var docRotationExposed: bool

  def isOperation(k: str): bool = k == "plc_operation"

  action init = all {
    headKind' = "none",
    headSigningKey' = "none",
    headHandle' = "none",
    headPds' = "none",
    headEpoch' = 0,
    docEpoch' = 0,
    docRendered' = false,
    docId' = "none",
    docAlias' = "none",
    docKey' = "none",
    docService' = "none",
    docRotationExposed' = false
  }

  // Install the current head from the log; the document is now stale (docEpoch
  // trails headEpoch) until render runs.
  action install = {
    nondet bundle = Set("genesis-A", "genesis-B", "tombstone", "none").oneOf()
    all {
      headKind' = if (bundle == "genesis-A" or bundle == "genesis-B") "plc_operation"
                  else if (bundle == "tombstone") "plc_tombstone"
                  else "none",
      headSigningKey' = if (bundle == "genesis-A") "sigA"
                        else if (bundle == "genesis-B") "sigB"
                        else "none",
      headHandle' = if (bundle == "genesis-A") "alice.example.com"
                    else if (bundle == "genesis-B") "bob.example.com"
                    else "none",
      headPds' = if (bundle == "genesis-A") "pds.one"
                 else if (bundle == "genesis-B") "pds.two"
                 else "none",
      headEpoch' = headEpoch + 1,
      docEpoch' = docEpoch,
      docRendered' = docRendered,
      docId' = docId,
      docAlias' = docAlias,
      docKey' = docKey,
      docService' = docService,
      docRotationExposed' = docRotationExposed
    }
  }

  action render = all {
    headKind' = headKind,
    headSigningKey' = headSigningKey,
    headHandle' = headHandle,
    headPds' = headPds,
    headEpoch' = headEpoch,
    docEpoch' = headEpoch,
    docRendered' = isOperation(headKind),
    docId' = if (isOperation(headKind)) "did:plc:genesis" else "none",
    docAlias' = if (isOperation(headKind)) headHandle else "none",
    docKey' = if (isOperation(headKind)) headSigningKey else "none",
    docService' = if (isOperation(headKind)) headPds else "none",
    docRotationExposed' = false
  }

  action step = any { init, install, render }

  val DocumentEpochNotAhead: bool = docEpoch <= headEpoch

  // When the document is current, every field mirrors the head it was rendered
  // from - and a non-operation head yields no rendered document.
  val DocMatchesHeadWhenRendered: bool =
    if (docEpoch == headEpoch)
      (if (isOperation(headKind))
        docRendered and docId == "did:plc:genesis" and docAlias == headHandle and
        docKey == headSigningKey and docService == headPds
      else
        not (docRendered))
    else true

  // rotationKeys are an op-log detail; the rendering never carries them.
  val RotationKeysNeverExposed: bool = not (docRotationExposed)
}
