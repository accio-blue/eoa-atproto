import {
  OVERRIDE_RANK,
  applyOverride,
  applyOverrides,
  matchesScene,
  rkeyOf,
} from './override.js';
import { describe, expect, it } from 'vitest';
import { OVERRIDE_NSID } from './scene.js';
import type { SceneOverride } from './scene.js';
import { sampleScene } from './test-fixtures.js';

const SCENE_URI = 'at://did:plc:tenant/ing.lexicon.canvas.scene/3kscene';
const KEY = { uri: SCENE_URI, overrideKey: '3kscene' };

const override = ({
  nodes,
  patch = {},
}: {
  readonly nodes: SceneOverride['nodes'];
  readonly patch?: Partial<SceneOverride>;
}): SceneOverride => ({
  $type: OVERRIDE_NSID,
  scene: SCENE_URI,
  nodes,
  createdAt: '2026-10-05T00:00:00.000Z',
  ...patch,
});

const nodeById = ({
  scene,
  id,
}: {
  readonly scene: typeof sampleScene;
  readonly id: string;
}) => scene.nodes.find((node) => node.id === id);

describe('applyOverride', () => {
  it('patches the fields given and leaves the rest of the node and scene alone', () => {
    const applied = applyOverride({
      scene: sampleScene,
      override: override({ nodes: [{ id: 't1', x: 999, order: 7 * 1024 }] }),
      key: KEY,
    });
    expect(nodeById({ scene: applied, id: 't1' })).toMatchObject({
      x: 999,
      order: 7168,
      y: 0,
      width: 200,
    });
    expect(nodeById({ scene: applied, id: 't1' })?.content).toEqual(
      nodeById({ scene: sampleScene, id: 't1' })?.content,
    );
    expect(nodeById({ scene: applied, id: 'g1' })).toEqual(
      nodeById({ scene: sampleScene, id: 'g1' }),
    );
    expect(applied.edges).toEqual(sampleScene.edges);
    // immutable: the input is untouched
    expect(nodeById({ scene: sampleScene, id: 't1' })?.x).toBe(0);
  });

  it('falls through fields the override leaves absent', () => {
    const applied = applyOverride({
      scene: sampleScene,
      override: override({ nodes: [{ id: 't1', y: 42 }] }),
      key: KEY,
    });
    expect(nodeById({ scene: applied, id: 't1' })).toMatchObject({
      x: 0,
      y: 42,
      width: 200,
      height: 80,
    });
  });

  it('ignores ids the scene does not have', () => {
    const applied = applyOverride({
      scene: sampleScene,
      override: override({
        nodes: [
          { id: 'nope', x: 1 },
          { id: 't1', x: 2 },
        ],
      }),
      key: KEY,
    });
    expect(applied.nodes).toHaveLength(sampleScene.nodes.length);
    expect(nodeById({ scene: applied, id: 't1' })?.x).toBe(2);
  });

  it('is a no-op when the scene at-uri or the sidecar key does not match', () => {
    const other = override({
      nodes: [{ id: 't1', x: 5 }],
      patch: {
        scene: 'at://did:plc:other/ing.lexicon.canvas.scene/3kother',
      },
    });
    expect(
      applyOverride({ scene: sampleScene, override: other, key: KEY }),
    ).toBe(sampleScene);
    expect(
      applyOverride({
        scene: sampleScene,
        override: override({ nodes: [{ id: 't1', x: 5 }] }),
        key: {
          uri: SCENE_URI,
          overrideKey: '3kdifferent',
        },
      }),
    ).toBe(sampleScene);
    expect(matchesScene({ override: other, key: KEY })).toBe(false);
  });

  it('hides a node by removing it and every edge that touches it', () => {
    const applied = applyOverride({
      scene: sampleScene,
      override: override({ nodes: [{ id: 'c1', hidden: true }] }),
      key: KEY,
    });
    expect(nodeById({ scene: applied, id: 'c1' })).toBeUndefined();
    expect(applied.nodes.map((node) => node.id)).not.toContain('c1');
    expect(applied.edges.map((edge) => edge.id)).toEqual([]);
  });

  it('ranks layers app < author < viewer, so the viewer wins per field', () => {
    const scene = applyOverrides({
      scene: sampleScene,
      uri: SCENE_URI,
      layers: [
        {
          layer: 'viewer',
          overrideKey: '3kscene',
          override: override({ nodes: [{ id: 't1', x: 30, y: 60 }] }),
        },
        {
          layer: 'app',
          overrideKey: '3kscene',
          override: override({ nodes: [{ id: 't1', x: 10, y: 10 }] }),
        },
        {
          layer: 'author',
          overrideKey: '3kscene',
          override: override({ nodes: [{ id: 't1', y: 20 }] }),
        },
      ],
    });
    expect(nodeById({ scene, id: 't1' })).toMatchObject({ x: 30, y: 60 });
    expect(OVERRIDE_RANK.app).toBeLessThan(OVERRIDE_RANK.author);
    expect(OVERRIDE_RANK.author).toBeLessThan(OVERRIDE_RANK.viewer);
  });

  it('drops a layer whose key belongs to another scene', () => {
    const scene = applyOverrides({
      scene: sampleScene,
      uri: SCENE_URI,
      layers: [
        {
          layer: 'viewer',
          overrideKey: '3kscene',
          override: override({ nodes: [{ id: 't1', x: 30 }] }),
        },
        {
          layer: 'author',
          overrideKey: '3kforeign',
          override: override({
            nodes: [{ id: 't1', x: 999 }],
            patch: {
              scene: 'at://did:plc:other/ing.lexicon.canvas.scene/3kforeign',
            },
          }),
        },
      ],
    });
    expect(nodeById({ scene, id: 't1' })?.x).toBe(30);
  });

  it('reads the rkey out of a well-formed at-uri only', () => {
    expect(rkeyOf(SCENE_URI)).toBe('3kscene');
    expect(rkeyOf('at://did:plc:x')).toBeUndefined();
    expect(rkeyOf('not a uri')).toBeUndefined();
  });
});
