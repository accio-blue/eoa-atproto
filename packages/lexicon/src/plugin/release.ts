/**
 * `ing.lexicon.plugin.release` — a plugin release, signed into the publisher's
 * own repo.
 *
 * The lexicon is the source of truth; this is its hand-typed mirror. This record
 * is the **trust anchor** an install verifies against: its `cid` is the bundle,
 * and its `artifact.sha256` the code the publisher published. A registry catalog
 * (`ing.lexicon.registry.manifest`) is untrusted; `@eoa/repo`'s
 * `verifyRelease` proves this record is in the publisher's signed commit and that
 * the bytes hash to `artifact.sha256` before anything runs (bean `blf2`).
 */
export const PLUGIN_RELEASE_NSID = 'ing.lexicon.plugin.release';

/** The published bytes: their checksum, and optionally size and fetch URL. */
export interface PluginArtifact {
  /** `base64url(sha256(bytes))` — what `verifyRelease` computes. */
  readonly sha256: string;
  readonly size?: number;
  readonly url?: string;
}

/** The stored record: one release (key `tid`), so history is a set, not a head. */
export interface PluginReleaseRecord {
  readonly $type: typeof PLUGIN_RELEASE_NSID;
  /** The plugin's NSID, matching its `ing.lexicon.plugin.manifest`. */
  readonly plugin: string;
  readonly version: string;
  /** The bundle CID this release names. */
  readonly cid: string;
  readonly artifact: PluginArtifact;
  readonly createdAt: string;
}
