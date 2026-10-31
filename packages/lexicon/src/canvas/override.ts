/**
 * Applying a layout override to a scene.
 *
 * The layering is the look model's, ADR 0002: `app < author < viewer`, applied
 * lowest rank first so the highest rank wins per field. An override is a
 * **sidecar** of a scene — its record key is the scene's rkey — so an override
 * is ignored unless its `scene` at-uri and its own key both match (the key is
 * user-controlled and not globally unique, so a mismatch must be ignored, never
 * applied to the wrong scene).
 *
 * Everything here is immutable: the input scene is never touched.
 */
import type { Scene, SceneNode, SceneOverride } from './scene.js';

export type OverrideLayer = 'app' | 'author' | 'viewer';

/** Lowest rank is applied first, so the highest rank wins. */
export const OVERRIDE_RANK: Readonly<Record<OverrideLayer, number>> = {
  app: 0,
  author: 1,
  viewer: 2,
};

/** `at://did/collection/rkey` -> `rkey`, or `undefined` when malformed. */
export const rkeyOf = (atUri: string): string | undefined => {
  const parts = atUri.split('/');
  return parts.length === 5 ? parts[4] : undefined;
};

export interface SceneKey {
  /** The scene's at-uri. */
  readonly uri: string;
  /** The override record's own rkey; the sidecar pattern requires the scene's. */
  readonly overrideKey: string;
}

export interface MatchesSceneParams {
  readonly override: SceneOverride;
  readonly key: SceneKey;
}

/** True when `override` is the sidecar of the scene at `key.uri`. */
export const matchesScene = ({ override, key }: MatchesSceneParams): boolean =>
  override.scene === key.uri && rkeyOf(key.uri) === key.overrideKey;

export interface OverrideLayerEntry {
  readonly layer: OverrideLayer;
  readonly override: SceneOverride;
  readonly overrideKey: string;
}

const patchNode = ({
  node,
  override,
}: {
  readonly node: SceneNode;
  readonly override: SceneOverride['nodes'][number];
}): SceneNode => ({
  ...node,
  ...(override.x === undefined ? {} : { x: override.x }),
  ...(override.y === undefined ? {} : { y: override.y }),
  ...(override.width === undefined ? {} : { width: override.width }),
  ...(override.height === undefined ? {} : { height: override.height }),
  ...(override.order === undefined ? {} : { order: override.order }),
});

export interface ApplyOverrideParams {
  readonly scene: Scene;
  readonly override: SceneOverride;
  readonly key: SceneKey;
}

/**
 * Apply one override. A node with `hidden: true` is removed from this view
 * along with every edge that touches it — the scene record has no `hidden`
 * field, so a view is the only place the flag can mean anything. Ids the scene
 * does not have are ignored, and an override that does not match `key` is a
 * no-op.
 */
export const applyOverride = ({
  scene,
  override,
  key,
}: ApplyOverrideParams): Scene => {
  if (!matchesScene({ override, key })) {
    return scene;
  }
  const patches = new Map(override.nodes.map((node) => [node.id, node]));
  const hidden = new Set(
    override.nodes
      .filter((node) => node.hidden === true)
      .map((node) => node.id),
  );
  const nodes = scene.nodes
    .filter((node) => !hidden.has(node.id))
    .map((node) => {
      const patch = patches.get(node.id);
      return patch === undefined ? node : patchNode({ node, override: patch });
    });
  const edges =
    hidden.size === 0
      ? scene.edges
      : scene.edges.filter(
          (edge) => !hidden.has(edge.fromNode) && !hidden.has(edge.toNode),
        );
  return { ...scene, nodes, edges };
};

export interface ApplyOverridesParams {
  readonly scene: Scene;
  readonly uri: string;
  readonly layers: ReadonlyArray<OverrideLayerEntry>;
}

/**
 * Apply a scene's override layers, lowest rank first. Layers of equal rank keep
 * the caller's order (a later entry wins).
 */
export const applyOverrides = ({
  scene,
  uri,
  layers,
}: ApplyOverridesParams): Scene =>
  [...layers]
    .sort((a, b) => OVERRIDE_RANK[a.layer] - OVERRIDE_RANK[b.layer])
    .reduce(
      (acc, entry) =>
        applyOverride({
          scene: acc,
          override: entry.override,
          key: { uri, overrideKey: entry.overrideKey },
        }),
      scene,
    );
