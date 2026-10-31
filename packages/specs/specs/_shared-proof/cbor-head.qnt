// _shared-proof: an end-to-end proof that a generated spec can import the
// shared layer (base + cbor + invariants), have it inlined into a
// self-contained model document, and be hashed together with every imported
// file (effects-of-atmosphere-ivbd / nkv2).
//
// The `_shared-proof` path is reserved for this proof; the dir is not part of
// the service enumeration.
module shared_proof_cbor_head {
  import base.* from "../../shared/base"
  import cbor.* from "../../shared/cbor"
  import invariants.* from "../../shared/invariants"

  var lastArg: int
  var lastClass: int
  var canonical: bool

  action init = all {
    lastArg' = 0,
    lastClass' = 0,
    canonical' = true
  }

  action putHead = {
    nondet n = Set(0, 23, 24, 256, 65536, 4294967296).oneOf()
    all {
      lastArg' = n,
      lastClass' = headClass(n),
      canonical' = isShortForm(n)
    }
  }

  action step = any { init, putHead }

  // invariants.qnt's `inRange` is inlined; base.qnt's `isNone`/`none` resolve
  val ClassInRange: bool = inRange(lastClass, 0, 4)
  val CanonicalIsShort: bool = canonical == isShortForm(lastArg)
}
