/**
 * `ing.lexicon.plugin.install` — a plugin installed into an account, and the
 * capabilities its tenant granted.
 *
 * The two records are deliberately separate: a *release* is the publisher's
 * claim about code (signed, in their repo), an *install* is the tenant's
 * decision to run it. The install names the release so a host can prove the
 * claim again on every wake — an isolate is not durable, and a plugin that was
 * running before an eviction must be re-verified, not remembered.
 *
 * `grants` is what the tenant allows; the plugin's own manifest declares what it
 * wants. The bridge denies anything not granted (deny-by-default), and `admin`
 * is not grantable at all (`@eoa/sandbox` capability gate).
 */
import { Schema } from 'effect';

export const PLUGIN_INSTALL_NSID = 'ing.lexicon.plugin.install';

/** An installed plugin: the release it came from and the capabilities it may use. */
export interface PluginInstallRecord {
  readonly $type?: typeof PLUGIN_INSTALL_NSID;
  /** The plugin's NSID — the record's rkey, so an account has one install per plugin. */
  readonly plugin: string;
  /** The release's version, so a failed fetch still says what should run. */
  readonly version: string;
  /** `at://<publisher>/ing.lexicon.plugin.release/<rkey>` — verified before anything spawns. */
  readonly release: string;
  /** The capability names the tenant granted; anything else is denied. */
  readonly grants: ReadonlyArray<string>;
  readonly createdAt: string;
}

/** The record as a schema: what the admin decodes before it shows an install. */
export const PluginInstallSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(PLUGIN_INSTALL_NSID)),
  plugin: Schema.String,
  version: Schema.String,
  release: Schema.String,
  grants: Schema.Array(Schema.String),
  createdAt: Schema.String,
});
