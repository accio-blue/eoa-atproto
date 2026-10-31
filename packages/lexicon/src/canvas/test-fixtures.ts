import {
  CANVAS,
  COMPONENT,
  FILE,
  GROUP,
  LINK,
  ORDER_STEP,
  SCENE_NSID,
  TEXT,
} from './scene.js';
import type { Scene, SceneNode } from './scene.js';

const COMPONENT_REF = 'at://did:plc:abc123/app.bsky.feed.post/3kpost';

// props hold the characters that would break an HTML comment envelope.
export const pluginNode: SceneNode = {
  id: 'c1',
  x: 320,
  y: 40,
  width: 240,
  height: 160,
  order: 4 * ORDER_STEP,
  ref: COMPONENT_REF,
  content: {
    $type: COMPONENT,
    componentUri: 'at://did:plc:abc123/at.inlay.component/3kcomp',
    props: {
      title: 'a --> <b> & "c"',
      rows: [1, 2, 3],
      nested: { ok: true, none: null },
    },
  },
};

// A nested scene. Kept out of sampleScene so the tests that count its nodes and
// notes do not move.
export const NESTED_SCENE =
  'at://did:plc:abc123/ing.lexicon.canvas.scene/3knest';
export const nestedCanvasNode: SceneNode = {
  id: 'n1',
  x: 40,
  y: 360,
  width: 300,
  height: 200,
  order: 6 * ORDER_STEP,
  content: { $type: CANVAS, scene: NESTED_SCENE },
};

// Text, group, file, link, plugin and an unknown open-union variant, ordered
// bottom to top by ORDER_STEP so a round trip is exactly equal.
export const sampleScene: Scene = {
  $type: SCENE_NSID,
  title: 'Sample',
  nodes: [
    {
      id: 'g1',
      x: -40,
      y: -40,
      width: 640,
      height: 400,
      order: 0,
      color: '4',
      content: {
        $type: GROUP,
        label: 'Cluster',
        background: 'bg.png',
        backgroundStyle: 'cover',
      },
    },
    {
      id: 't1',
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      order: ORDER_STEP,
      color: '#FF0000',
      content: { $type: TEXT, text: '# Hello\nworld' },
    },
    {
      id: 'f1',
      x: 0,
      y: 120,
      width: 200,
      height: 120,
      order: 2 * ORDER_STEP,
      content: { $type: FILE, file: 'notes/readme.md', subpath: '#intro' },
    },
    {
      id: 'l1',
      x: 0,
      y: 280,
      width: 200,
      height: 60,
      order: 3 * ORDER_STEP,
      content: { $type: LINK, url: 'https://jsoncanvas.org/spec/1.0/' },
    },
    pluginNode,
    {
      id: 'u1',
      x: 620,
      y: 40,
      width: 100,
      height: 100,
      order: 5 * ORDER_STEP,
      content: { $type: 'com.acme.canvas.chart', series: [1, 2], label: 'x' },
    },
  ],
  edges: [
    {
      id: 'e1',
      fromNode: 't1',
      fromSide: 'right',
      toNode: 'c1',
      toSide: 'left',
      toEnd: 'arrow',
    },
    {
      id: 'e2',
      fromNode: 'c1',
      toNode: 'u1',
      fromEnd: 'none',
      label: 'feeds',
      color: '2',
    },
  ],
  createdAt: '2026-10-05T00:00:00.000Z',
};
