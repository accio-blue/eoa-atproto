import { COMPONENT, FILE, GROUP, LINK, TEXT, byOrder } from './scene.js';
import type { Scene, SceneNode } from './scene.js';
import { describe, expect, it } from 'vitest';
import { nestedCanvasNode, sampleScene } from './test-fixtures.js';
import { sceneToCanvasNodes } from './canvas-nodes.js';

const node = ({
  id,
  order,
  content,
}: {
  readonly id: string;
  readonly order: number;
  readonly content: SceneNode['content'];
}): SceneNode => ({ id, x: 1, y: 2, width: 30, height: 40, order, content });

const sceneOf = (...nodes: SceneNode[]): Scene => ({
  ...sampleScene,
  nodes,
  edges: [],
});

const text = ({
  id,
  order,
}: {
  readonly id: string;
  readonly order: number;
}): SceneNode => node({ id, order, content: { $type: TEXT, text: id } });

describe('sceneToCanvasNodes: z-order', () => {
  // This is what feeds createCanvas's index-as-z-index contract: createCanvas
  // gives a node z-index = its array index and hit-tests the highest index
  // first (headless canvas.ts / canvas-math.ts), so the order of this array IS
  // the stacking order. This package cannot import headless, so it pins the
  // array order only.
  it('lists nodes bottom to top by order, whatever the input order', () => {
    const scene = sceneOf(
      text({ id: 'c', order: 30 }),
      text({ id: 'a', order: 10 }),
      text({ id: 'b', order: 20 }),
    );

    expect(sceneToCanvasNodes(scene).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('is exactly the byOrder sort of the scene', () => {
    const scene = {
      ...sampleScene,
      nodes: [...sampleScene.nodes].reverse(),
    };

    expect(sceneToCanvasNodes(scene).map((n) => n.id)).toEqual(
      [...scene.nodes].sort(byOrder).map((n) => n.id),
    );
  });

  it('breaks a tie in order by id, not by input order', () => {
    const forward = sceneOf(
      text({ id: 'a', order: 5 }),
      text({ id: 'b', order: 5 }),
      text({ id: 'c', order: 5 }),
    );
    const backward = sceneOf(
      text({ id: 'c', order: 5 }),
      text({ id: 'b', order: 5 }),
      text({ id: 'a', order: 5 }),
    );

    expect(sceneToCanvasNodes(forward).map((n) => n.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sceneToCanvasNodes(backward).map((n) => n.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('falls back to input order only when order and id are both equal', () => {
    const scene = sceneOf(
      node({ id: 'x', order: 5, content: { $type: TEXT, text: 'first' } }),
      node({ id: 'x', order: 5, content: { $type: TEXT, text: 'second' } }),
    );

    expect(sceneToCanvasNodes(scene).map((n) => n.label)).toEqual([
      'first',
      'second',
    ]);
  });

  it('does not modify the scene', () => {
    const scene = sceneOf(
      text({ id: 'b', order: 2 }),
      text({ id: 'a', order: 1 }),
    );
    sceneToCanvasNodes(scene);

    expect(scene.nodes.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('keeps the frame and drops what createCanvas does not take', () => {
    const [out] = sceneToCanvasNodes(
      sceneOf({
        ...text({ id: 'a', order: 1 }),
        color: '4',
        ref: 'at://did:plc:x/a.b/c',
      }),
    );

    expect(Object.keys(out ?? {}).sort()).toEqual([
      'height',
      'id',
      'label',
      'role',
      'roleDescription',
      'width',
      'x',
      'y',
    ]);
    expect(out).toMatchObject({ id: 'a', x: 1, y: 2, width: 30, height: 40 });
  });
});

describe('sceneToCanvasNodes: labels and roles', () => {
  const only = (content: SceneNode['content']) =>
    sceneToCanvasNodes(sceneOf(node({ id: 'n', order: 0, content })))[0];

  it('labels each known variant', () => {
    expect(only({ $type: TEXT, text: '# Hello\nworld' })).toMatchObject({
      label: 'Hello',
      role: 'article',
      roleDescription: 'text note',
    });
    expect(
      only({ $type: FILE, file: 'notes/readme.md', subpath: '#intro' }),
    ).toMatchObject({ label: 'readme.md', role: 'figure' });
    expect(only({ $type: LINK, url: 'https://jsoncanvas.org' })).toMatchObject({
      label: 'https://jsoncanvas.org',
    });
    expect(only({ $type: GROUP, label: 'Cluster' })).toMatchObject({
      label: 'Cluster',
      role: 'group',
    });
    expect(
      only({
        $type: COMPONENT,
        componentUri: 'at://did:plc:abc123/at.inlay.component/3kcomp',
      }),
    ).toMatchObject({ label: 'Component 3kcomp', role: 'figure' });
    expect(only(nestedCanvasNode.content)).toMatchObject({
      label: 'Nested canvas 3knest',
      role: 'figure',
      roleDescription: 'nested canvas',
    });
  });

  it('falls back to a generic label when the variant has nothing to name it by', () => {
    expect(only({ $type: TEXT, text: '  \n ' })?.label).toBe('Text note');
    expect(only({ $type: FILE, file: 'dir/' })?.label).toBe('File');
    expect(only({ $type: GROUP })?.label).toBe('Group');
    expect(
      only({ $type: COMPONENT, componentUri: 'not an at-uri' })?.label,
    ).toBe('Component');
    expect(
      only({ $type: 'ing.lexicon.canvas.defs#canvas', scene: 'x' })?.label,
    ).toBe('Nested canvas');
  });

  it('does not throw on a known variant whose fields are missing or mistyped', () => {
    expect(only({ $type: TEXT })?.label).toBe('Text note');
    expect(only({ $type: LINK, url: 7 })?.label).toBe('Link');
    expect(only({ $type: COMPONENT })?.label).toBe('Component');
  });

  it('maps an unknown $type to an unsupported label with no role, and keeps its frame', () => {
    const [out] = sceneToCanvasNodes(
      sceneOf(...sampleScene.nodes.filter((n) => n.id === 'u1')),
    );

    expect(out).toEqual({
      id: 'u1',
      x: 620,
      y: 40,
      width: 100,
      height: 100,
      label: 'Unsupported node (com.acme.canvas.chart)',
    });
  });

  it('clips a long label', () => {
    const label = only({ $type: TEXT, text: 'x'.repeat(500) })?.label ?? '';

    expect(label).toHaveLength(80);
    expect(label.endsWith('…')).toBe(true);
  });

  it('maps the whole sample scene, unknown variant included, in order', () => {
    const out = sceneToCanvasNodes(sampleScene);

    expect(out.map((n) => n.id)).toEqual(['g1', 't1', 'f1', 'l1', 'c1', 'u1']);
    expect(out.every((n) => n.label !== '')).toBe(true);
  });
});
