import { CANVAS, SCENE_NSID, TEXT } from './scene.js';
import {
  NESTED_SCENE,
  nestedCanvasNode,
  pluginNode,
  sampleScene,
} from './test-fixtures.js';
import {
  decodeJsonCanvas,
  fromJsonCanvas,
  toJsonCanvas,
} from './json-canvas.js';
import { describe, expect, it } from 'vitest';
import { parseJson, stringifyJson } from '../json.js';
import type { JsonCanvas } from './json-canvas.js';
import { Result } from 'effect';
import type { Scene } from './scene.js';

const valid = (input: unknown): JsonCanvas => {
  const result = decodeJsonCanvas(input);
  if (Result.isFailure(result)) {
    throw new Error(result.failure.message);
  }
  return result.success;
};

const importOptions = {
  createdAt: sampleScene.createdAt,
  ...(sampleScene.title === undefined ? {} : { title: sampleScene.title }),
};

describe('toJsonCanvas / fromJsonCanvas', () => {
  it('round-trips text, group, file, link, edge, plugin and unknown nodes', () => {
    const { canvas } = toJsonCanvas({ scene: sampleScene });

    expect(
      fromJsonCanvas({ canvas: valid(canvas), options: importOptions }),
    ).toEqual(sampleScene);
  });

  it('round-trips through serialized JSON, as a .canvas file would', () => {
    const { canvas } = toJsonCanvas({ scene: sampleScene });
    const file = parseJson(stringifyJson(canvas));

    expect(
      fromJsonCanvas({ canvas: valid(file), options: importOptions }),
    ).toEqual(sampleScene);
  });

  it('round-trips a nested canvas node, naming its scene in the placeholder', () => {
    const scene: Scene = {
      ...sampleScene,
      nodes: [...sampleScene.nodes, nestedCanvasNode],
    };
    const { canvas, notes } = toJsonCanvas({ scene });
    const placeholder = (canvas.nodes ?? []).find((n) => n.id === 'n1');

    expect(placeholder?.type === 'text' && placeholder.text).toContain(
      `**Nested canvas** \`${NESTED_SCENE}\``,
    );
    expect(notes).toContainEqual(
      expect.objectContaining({ action: 'placeholder', id: 'n1' }),
    );
    expect(
      fromJsonCanvas({ canvas: valid(canvas), options: importOptions }),
    ).toEqual(scene);
  });

  it('keeps a canvas placeholder without a scene as plain text', () => {
    const canvas = valid({
      nodes: [
        {
          id: 'n',
          type: 'text',
          text: `<!-- ing.lexicon.canvas:node {"content":{"$type":"${CANVAS}"}} -->`,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
    });

    expect(
      fromJsonCanvas({
        canvas,
        options: { createdAt: sampleScene.createdAt },
      }).nodes[0]?.content.$type,
    ).toBe(TEXT);
  });

  it('writes nodes bottom to top by order, ties broken by id', () => {
    const scene: Scene = {
      ...sampleScene,
      nodes: [
        {
          ...pluginNode,
          id: 'b',
          order: 10,
          content: { $type: TEXT, text: 'b' },
        },
        {
          ...pluginNode,
          id: 'a',
          order: 10,
          content: { $type: TEXT, text: 'a' },
        },
        {
          ...pluginNode,
          id: 'z',
          order: -5,
          content: { $type: TEXT, text: 'z' },
        },
      ],
      edges: [],
    };

    const ids = (toJsonCanvas({ scene }).canvas.nodes ?? []).map((n) => n.id);

    expect(ids).toEqual(['z', 'a', 'b']);
  });
});

describe('export policy', () => {
  it('turns a plugin node into a text placeholder carrying its componentUri', () => {
    const { canvas, notes } = toJsonCanvas({ scene: sampleScene });
    const placeholder = (canvas.nodes ?? []).find((n) => n.id === 'c1');

    expect(placeholder?.type).toBe('text');
    expect(placeholder?.type === 'text' && placeholder.text).toContain(
      'at://did:plc:abc123/at.inlay.component/3kcomp',
    );
    expect(notes).toContainEqual(
      expect.objectContaining({ action: 'placeholder', id: 'c1' }),
    );
    expect(notes).toContainEqual(
      expect.objectContaining({ action: 'placeholder', id: 'u1' }),
    );
  });

  it('keeps the placeholder a valid JSON Canvas 1.0 document, props with --> and all', () => {
    const { canvas } = toJsonCanvas({ scene: sampleScene });
    const text = stringifyJson(canvas);

    expect(Result.isSuccess(decodeJsonCanvas(parseJson(text)))).toBe(true);
    // the comment holding props can never be closed early
    const placeholder = (canvas.nodes ?? []).find((n) => n.id === 'c1');
    const body = placeholder?.type === 'text' ? placeholder.text : '';
    expect(body.match(/-->/g)).toHaveLength(1);
  });

  it('exports only the four JSON Canvas node types', () => {
    const { canvas } = toJsonCanvas({ scene: sampleScene });

    expect(new Set((canvas.nodes ?? []).map((n) => n.type))).toEqual(
      new Set(['text', 'file', 'link', 'group']),
    );
  });

  it('drops plugin nodes and the edges that touch them, with notes, when asked', () => {
    const { canvas, notes } = toJsonCanvas({
      scene: sampleScene,
      options: { plugins: 'drop' },
    });

    expect((canvas.nodes ?? []).map((n) => n.id)).toEqual([
      'g1',
      't1',
      'f1',
      'l1',
    ]);
    expect(canvas.edges).toEqual([]);
    expect(
      notes.filter((n) => n.action === 'node-dropped').map((n) => n.id),
    ).toEqual(['c1', 'u1']);
    expect(
      notes.filter((n) => n.action === 'edge-dropped').map((n) => n.id),
    ).toEqual(['e1', 'e2']);
    expect(Result.isSuccess(decodeJsonCanvas(canvas))).toBe(true);
  });

  it('notes a ref that JSON Canvas cannot hold', () => {
    const scene: Scene = {
      ...sampleScene,
      nodes: [
        {
          ...pluginNode,
          id: 'r1',
          content: { $type: TEXT, text: 'about a post' },
        },
      ],
      edges: [],
    };

    expect(toJsonCanvas({ scene }).notes).toEqual([
      expect.objectContaining({ action: 'ref-lost', id: 'r1' }),
    ]);
  });

  it('leaves out values JSON Canvas 1.0 does not allow, so the file stays valid', () => {
    const scene: Scene = {
      ...sampleScene,
      nodes: sampleScene.nodes.filter((n) => n.id === 't1' || n.id === 'f1'),
      edges: [
        {
          id: 'e9',
          fromNode: 't1',
          fromSide: 'center',
          toNode: 'f1',
          toEnd: 'diamond',
          color: 'teal',
        },
      ],
    };

    const { canvas, notes } = toJsonCanvas({ scene });

    expect(canvas.edges).toEqual([{ id: 'e9', fromNode: 't1', toNode: 'f1' }]);
    expect(notes.map((n) => n.action)).toEqual([
      'field-dropped',
      'field-dropped',
      'field-dropped',
    ]);
    expect(Result.isSuccess(decodeJsonCanvas(canvas))).toBe(true);
  });

  it('drops an edge whose endpoint is not in the scene', () => {
    const scene: Scene = {
      ...sampleScene,
      edges: [{ id: 'bad', fromNode: 't1', toNode: 'nope' }],
    };

    const { canvas, notes } = toJsonCanvas({ scene });

    expect(canvas.edges).toEqual([]);
    expect(notes).toContainEqual(
      expect.objectContaining({ action: 'edge-dropped', id: 'bad' }),
    );
  });
});

describe('import', () => {
  // https://github.com/obsidianmd/jsoncanvas/blob/main/sample.canvas (MIT)
  const sample = {
    nodes: [
      {
        id: 'g',
        type: 'group',
        x: -300,
        y: -460,
        width: 610,
        height: 200,
        label: 'JSON Canvas',
      },
      {
        id: 'f',
        type: 'file',
        file: 'readme.md',
        x: -280,
        y: -200,
        width: 570,
        height: 560,
        color: '6',
      },
      {
        id: 't',
        type: 'text',
        text: 'Learn more:\n\n- [Apps](/docs/apps.md)',
        x: 40,
        y: -440,
        width: 250,
        height: 160,
      },
      {
        id: 'l',
        type: 'link',
        url: 'https://jsoncanvas.org',
        x: 360,
        y: -400,
        width: 400,
        height: 400,
      },
    ],
    edges: [
      {
        id: 'e',
        fromNode: 'f',
        fromSide: 'right',
        toNode: 't',
        toSide: 'left',
      },
    ],
  };

  it('maps the four JSON Canvas types back, array position becoming order', () => {
    const scene = fromJsonCanvas({
      canvas: valid(sample),
      options: { createdAt: sampleScene.createdAt },
    });

    expect(scene.$type).toBe(SCENE_NSID);
    expect(scene.nodes.map((n) => [n.id, n.content.$type, n.order])).toEqual([
      ['g', 'ing.lexicon.canvas.defs#group', 0],
      ['f', 'ing.lexicon.canvas.defs#file', 1024],
      ['t', 'ing.lexicon.canvas.defs#text', 2048],
      ['l', 'ing.lexicon.canvas.defs#link', 3072],
    ]);
    expect(scene.nodes[1]?.color).toBe('6');
    expect(scene.edges).toEqual(sample.edges);
  });

  it('keeps an ordinary text node text, even one that mentions the marker', () => {
    const canvas = valid({
      nodes: [
        {
          id: 'n',
          type: 'text',
          text: '<!-- ing.lexicon.canvas:node {"content":{"$type":"ing.lexicon.canvas.defs#text","text":"x"}} -->',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
    });

    expect(
      fromJsonCanvas({
        canvas,
        options: { createdAt: sampleScene.createdAt },
      }).nodes[0]?.content.$type,
    ).toBe(TEXT);
  });

  it('accepts a document with neither nodes nor edges', () => {
    expect(
      fromJsonCanvas({
        canvas: valid({}),
        options: { createdAt: sampleScene.createdAt },
      }),
    ).toMatchObject({
      nodes: [],
      edges: [],
    });
  });
});

describe('decodeJsonCanvas rejects what JSON Canvas 1.0 forbids', () => {
  const node = {
    id: 'a',
    type: 'text',
    text: 't',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };

  it.each([
    ['a float coordinate', { nodes: [{ ...node, x: 1.5 }] }],
    ['an unknown node type', { nodes: [{ ...node, type: 'video' }] }],
    ['a text node without text', { nodes: [{ ...node, text: undefined }] }],
    ['a duplicate node id', { nodes: [node, node] }],
    [
      'an edge to a missing node',
      { nodes: [node], edges: [{ id: 'e', fromNode: 'a', toNode: 'x' }] },
    ],
    [
      'a bad side',
      {
        nodes: [node, { ...node, id: 'b' }],
        edges: [{ id: 'e', fromNode: 'a', toNode: 'b', toSide: 'middle' }],
      },
    ],
    ['a bad colour', { nodes: [{ ...node, color: '7' }] }],
    ['a negative width', { nodes: [{ ...node, width: -1 }] }],
  ])('%s', (_name, input) => {
    expect(Result.isFailure(decodeJsonCanvas(input))).toBe(true);
  });
});
