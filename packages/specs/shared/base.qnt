// shared/base.qnt — the base vocabulary every service spec shares: the absent
// sentinel and sample identifiers for the atproto formats specs exchange.
//
// Pure defs only: import it with `import base.* from "../shared/base"`.
//
// The supported subset has no string parsing and no set membership, so a
// validity predicate is an explicit disjunction over the sample vocabulary a
// spec actually carries in its state — never a real parser. Add samples here
// when a spec needs a new one.
module base {
  // The convention for "no value" across every service spec.
  def none: str = "none"
  def isNone(value: str): bool = value == none

  // --- DID ---------------------------------------------------------------
  def didPlcSample: str = "did:plc:genesis"
  def didWebSample: str = "did:web:example.com"
  def isDid(value: str): bool =
    or(value == didPlcSample, value == didWebSample)

  // --- handle ------------------------------------------------------------
  def handleSample: str = "alice.example.com"
  def isHandle(value: str): bool = value == handleSample

  // --- NSID (namespaced identifier, e.g. a lexicon id) -------------------
  def nsidSample: str = "app.bsky.feed.post"
  def isNsid(value: str): bool = or(value == nsidSample, isNone(value))

  // --- AT-URI ------------------------------------------------------------
  def atUriSample: str =
    "at://did:plc:genesis/app.bsky.feed.post/3jzsm4zqb2s2a"
  def isAtUri(value: str): bool = or(value == atUriSample, isNone(value))

  // --- CID (content identifier) ------------------------------------------
  def cidSample: str =
    "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uygzv5kkz2rq7v5test"
  def isCid(value: str): bool = or(value == cidSample, isNone(value))

  // --- TID (timestamp identifier, always 13 chars in practice) -----------
  def tidSample: str = "3jzsm4zqb2s2a"
  def isTid(value: str): bool = value == tidSample

  // --- record key (rkey) -------------------------------------------------
  def rkeySample: str = "3jzsm4zqb2s2a"
  def isRkey(value: str): bool = or(value == rkeySample, isNone(value))
}
