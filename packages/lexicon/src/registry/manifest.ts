/**
 * `ing.lexicon.registry.manifest` — a registry's published catalog.
 *
 * The lexicon is the source of truth; this is its hand-typed mirror. A manifest
 * is **untrusted**: publishing a module here says nothing about who made it. A
 * reader takes a manifest only from a registry DID the tenant accepts (grill
 * `8r3q` R4) and then verifies the module's own publisher-signed release
 * (`ing.lexicon.plugin.release`).
 */
export const REGISTRY_MANIFEST_NSID = 'ing.lexicon.registry.manifest';

/** The closed set of module kinds a registry may offer. */
export const REGISTRY_MODULE_TYPES = [
  'tool',
  'datatype',
  'component-set',
] as const;
export type RegistryModuleType = (typeof REGISTRY_MODULE_TYPES)[number];

/** One installable bundle. `cid` is the pin; a reader may opt into float. */
export interface RegistryModuleEntry {
  readonly id: string;
  readonly version: string;
  readonly cid: string;
  readonly url?: string;
  readonly type: RegistryModuleType;
  readonly icon?: string;
}

/** The stored record: one per registry repo (key `literal:self`). */
export interface RegistryManifestRecord {
  readonly $type: typeof REGISTRY_MANIFEST_NSID;
  readonly modules: ReadonlyArray<RegistryModuleEntry>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}
