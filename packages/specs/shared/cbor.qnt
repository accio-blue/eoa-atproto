// shared/cbor.qnt — CBOR head-class vocabulary, shared by every spec that
// reasons about DAG-CBOR encoding (de-dupes the verbatim `headClass` and
// `isShortForm` that lived in the head / dagcbor specs).
//
// Pure defs only: import it with `import cbor.* from "../shared/cbor"`.
// Stays inside the generator's supported subset (int comparisons nested in
// `ite`/`not`), so importing specs generate and interpret cleanly.
module cbor {
  // Minimal-length additional-info class of a CBOR argument value:
  //   0 -> inline (0..23), 1 -> 1 byte, 2 -> 2 bytes, 3 -> 4 bytes, 4 -> 8 bytes
  def headClass(arg: int): int =
    if (arg < 24) 0
    else if (arg < 256) 1
    else if (arg < 65536) 2
    else if (arg < 4294967296) 3
    else 4

  // An argument in the single-byte class (major type << 5 | 24) encodes with no
  // extra bytes — the canonical short form.
  def isShortForm(arg: int): bool = not (arg >= 24)

  // The canonical (shortest) extra-byte count for an argument, as the number of
  // 8-bit groups; a convenience over `headClass` for encoding specs.
  def extraByteCount(arg: int): int =
    if (arg < 24) 0 else if (arg < 256) 1 else if (arg < 65536) 2 else if (arg < 4294967296) 3 else 8
}
