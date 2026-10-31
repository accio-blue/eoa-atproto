import {
  CANVAS,
  COMPONENT,
  FILE,
  GROUP,
  LINK,
  ORDER_STEP,
  SCENE_NSID,
  TEXT,
  byOrder,
} from './scene.js';
import type {
  ComponentContent,
  FileContent,
  GroupContent,
  LinkContent,
  NodeContent,
  Scene,
  SceneEdge,
  SceneNode,
  TextContent,
  UnknownContent,
} from './scene.js';
import { Predicate, Result, Schema } from 'effect';
import { stringifyJson } from '../json.js';

// JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/), strict where the spec is
// explicit. Deliberate leniency: a hex colour may be 3-8 digits (the spec only
// shows #RRGGBB). Deliberate strictness: width/height >= 0 and ids of at most
// 128 UTF-8 bytes, because the scene lexicon says so.

const MAX_ID_BYTES = 128;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((s: string) => utf8Bytes(s) <= MAX_ID_BYTES, {
    expected: `an id of at most ${MAX_ID_BYTES} UTF-8 bytes`,
  }),
);
const CANVAS_COLOR = /^(#[0-9a-fA-F]{3,8}|[1-6])$/;
const CanvasColor = Schema.String.check(Schema.isPattern(CANVAS_COLOR));
const Size = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const ENDS = ['none', 'arrow'] as const;
const BACKGROUND_STYLES = ['cover', 'ratio', 'repeat'] as const;

const frame = {
  id: Id,
  x: Schema.Int,
  y: Schema.Int,
  width: Size,
  height: Size,
  color: Schema.optionalKey(CanvasColor),
};

const JsonCanvasNodeSchema = Schema.Union([
  Schema.Struct({
    ...frame,
    type: Schema.Literal('text'),
    text: Schema.String,
  }),
  Schema.Struct({
    ...frame,
    type: Schema.Literal('file'),
    file: Schema.String,
    subpath: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...frame,
    type: Schema.Literal('link'),
    url: Schema.String,
  }),
  Schema.Struct({
    ...frame,
    type: Schema.Literal('group'),
    label: Schema.optionalKey(Schema.String),
    background: Schema.optionalKey(Schema.String),
    backgroundStyle: Schema.optionalKey(Schema.Literals(BACKGROUND_STYLES)),
  }),
]);

const JsonCanvasEdgeSchema = Schema.Struct({
  id: Id,
  fromNode: Id,
  fromSide: Schema.optionalKey(Schema.Literals(SIDES)),
  fromEnd: Schema.optionalKey(Schema.Literals(ENDS)),
  toNode: Id,
  toSide: Schema.optionalKey(Schema.Literals(SIDES)),
  toEnd: Schema.optionalKey(Schema.Literals(ENDS)),
  color: Schema.optionalKey(CanvasColor),
  label: Schema.optionalKey(Schema.String),
});

// Ids unique per kind and every edge endpoint present: the two rules the spec
// states in prose ("a unique ID", "the node id where the connection starts").
const JsonCanvasSchema = Schema.Struct({
  nodes: Schema.optionalKey(Schema.Array(JsonCanvasNodeSchema)),
  edges: Schema.optionalKey(Schema.Array(JsonCanvasEdgeSchema)),
}).check(
  Schema.makeFilter((canvas) => {
    const issues: string[] = [];
    const nodeIds = new Set<string>();
    for (const node of canvas.nodes ?? []) {
      if (nodeIds.has(node.id)) {
        issues.push(`duplicate node id "${node.id}"`);
      }
      nodeIds.add(node.id);
    }
    const edgeIds = new Set<string>();
    for (const edge of canvas.edges ?? []) {
      if (edgeIds.has(edge.id)) {
        issues.push(`duplicate edge id "${edge.id}"`);
      }
      edgeIds.add(edge.id);
      for (const end of [edge.fromNode, edge.toNode]) {
        if (!nodeIds.has(end)) {
          issues.push(`edge "${edge.id}" points at missing node "${end}"`);
        }
      }
    }
    return issues;
  }),
);

export type JsonCanvas = typeof JsonCanvasSchema.Type;
export type JsonCanvasNode = NonNullable<JsonCanvas['nodes']>[number];
export type JsonCanvasEdge = NonNullable<JsonCanvas['edges']>[number];

// Untrusted input -> typed, validated document (Result, never throws).
export const decodeJsonCanvas = Schema.decodeUnknownResult(JsonCanvasSchema);

// --- placeholder envelope ---------------------------------------------------
// A node JSON Canvas cannot express (a plugin component, or a variant this
// build does not know) leaves as a `text` node: readable Markdown plus an HTML
// comment holding the node's content and ref verbatim, so import can restore
// it. `<` and `>` are \u-escaped inside the JSON, so it can never contain `-->`.

const MARKER = 'ing.lexicon.canvas:node';
const MARKER_RE = /<!-- ing\.lexicon\.canvas:node (\{.*\}) -->\s*$/s;
const STANDARD = new Set([TEXT, FILE, LINK, GROUP]);

// A node's content and its optional ref: what a placeholder carries and what
// import yields.
interface Imported {
  readonly content: NodeContent;
  readonly ref?: string;
}

const marker = (payload: Imported): string =>
  `<!-- ${MARKER} ${stringifyJson(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;

const decodePayload = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      content: Schema.Record(Schema.String, Schema.Json),
      ref: Schema.optionalKey(Schema.String),
    }),
  ),
);

// A placeholder may restore a component, a nested canvas or an unknown variant,
// never a standard type (those have their own JSON Canvas node) and never a
// component or canvas without its uri (the record would not validate).
const isOpaque = (content: {
  readonly [key: string]: Schema.Json;
}): content is UnknownContent => {
  const type = content['$type'];
  return (
    typeof type === 'string' &&
    !STANDARD.has(type) &&
    (type !== COMPONENT || typeof content['componentUri'] === 'string') &&
    (type !== CANVAS || typeof content['scene'] === 'string')
  );
};

const parsePlaceholder = (text: string): Imported | undefined => {
  const json = MARKER_RE.exec(text)?.[1];
  if (json === undefined) {
    return undefined;
  }
  const payload = decodePayload(json);
  if (Result.isFailure(payload) || !isOpaque(payload.success.content)) {
    return undefined;
  }
  const { content, ref } = payload.success;
  return ref === undefined ? { content } : { content, ref };
};

// --- export -----------------------------------------------------------------

export type ExportAction =
  | 'placeholder'
  | 'node-dropped'
  | 'edge-dropped'
  | 'field-dropped'
  | 'ref-lost';

// What the export changed, so the caller can show it. `id` is the node or edge.
export interface ExportNote {
  readonly action: ExportAction;
  readonly id: string;
  readonly detail: string;
}

export interface ExportOptions {
  // 'placeholder' (default): non-standard nodes become a text node carrying
  // their content. 'drop': they are removed, with an 'node-dropped' note, and
  // so are the edges that touched them.
  readonly plugins?: 'placeholder' | 'drop';
}

export interface ExportResult {
  readonly canvas: JsonCanvas;
  readonly notes: readonly ExportNote[];
}

const isText = (c: NodeContent): c is TextContent => c.$type === TEXT;
const isFile = (c: NodeContent): c is FileContent => c.$type === FILE;
const isLink = (c: NodeContent): c is LinkContent => c.$type === LINK;
const isGroup = (c: NodeContent): c is GroupContent => c.$type === GROUP;
const isComponent = (c: NodeContent): c is ComponentContent =>
  c.$type === COMPONENT &&
  Predicate.hasProperty(c, 'componentUri') &&
  typeof c.componentUri === 'string';
const isCanvas = Schema.is(
  Schema.Struct({ $type: Schema.Literal(CANVAS), scene: Schema.String }),
);

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: string): value is T =>
    allowed.some((a) => a === value);
const isSide = oneOf(SIDES);
const isEnd = oneOf(ENDS);
const isBackgroundStyle = oneOf(BACKGROUND_STYLES);

// A scene value outside what JSON Canvas 1.0 allows is left out, and noted.
const checked = <T extends string>({
  value,
  valid,
  id,
  field,
  notes,
}: {
  readonly value: string | undefined;
  readonly valid: (v: string) => v is T;
  readonly id: string;
  readonly field: string;
  readonly notes: ExportNote[];
}): T | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (valid(value)) {
    return value;
  }
  notes.push({
    action: 'field-dropped',
    id,
    detail: `${field} "${value}" is not a JSON Canvas 1.0 value`,
  });
  return undefined;
};

const isCanvasColor = (v: string): v is string => CANVAS_COLOR.test(v);

const placeholderText = (node: SceneNode): string => {
  const { content } = node;
  const what = isComponent(content)
    ? `**Plugin component** \`${content.componentUri}\``
    : isCanvas(content)
      ? `**Nested canvas** \`${content.scene}\``
      : `**Unsupported node** \`${content.$type}\``;
  const payload =
    node.ref === undefined ? { content } : { content, ref: node.ref };
  return `${what}\n\n${marker(payload)}`;
};

const exportNode = ({
  node,
  plugins,
  notes,
}: {
  readonly node: SceneNode;
  readonly plugins: 'placeholder' | 'drop';
  readonly notes: ExportNote[];
}): JsonCanvasNode | undefined => {
  const { id, x, y, width, height, content } = node;
  const color = checked({
    value: node.color,
    valid: isCanvasColor,
    id,
    field: 'color',
    notes,
  });
  const base = {
    id,
    x,
    y,
    width,
    height,
    ...(color === undefined ? {} : { color }),
  };

  if (
    node.ref !== undefined &&
    (isText(content) || isFile(content) || isLink(content) || isGroup(content))
  ) {
    notes.push({
      action: 'ref-lost',
      id,
      detail: `JSON Canvas has no place for ref ${node.ref}`,
    });
  }
  if (isText(content)) {
    return { ...base, type: 'text', text: content.text };
  }
  if (isFile(content)) {
    return {
      ...base,
      type: 'file',
      file: content.file,
      ...(content.subpath === undefined ? {} : { subpath: content.subpath }),
    };
  }
  if (isLink(content)) {
    return { ...base, type: 'link', url: content.url };
  }
  if (isGroup(content)) {
    const backgroundStyle = checked({
      value: content.backgroundStyle,
      valid: isBackgroundStyle,
      id,
      field: 'backgroundStyle',
      notes,
    });
    return {
      ...base,
      type: 'group',
      ...(content.label === undefined ? {} : { label: content.label }),
      ...(content.background === undefined
        ? {}
        : { background: content.background }),
      ...(backgroundStyle === undefined ? {} : { backgroundStyle }),
    };
  }
  if (plugins === 'drop') {
    notes.push({
      action: 'node-dropped',
      id,
      detail: `${content.$type} has no JSON Canvas type`,
    });
    return undefined;
  }
  notes.push({
    action: 'placeholder',
    id,
    detail: `${content.$type} exported as a text node`,
  });
  return { ...base, type: 'text', text: placeholderText(node) };
};

const exportEdge = ({
  edge,
  notes,
}: {
  readonly edge: SceneEdge;
  readonly notes: ExportNote[];
}): JsonCanvasEdge => {
  const { id } = edge;
  const fromSide = checked({
    value: edge.fromSide,
    valid: isSide,
    id,
    field: 'fromSide',
    notes,
  });
  const toSide = checked({
    value: edge.toSide,
    valid: isSide,
    id,
    field: 'toSide',
    notes,
  });
  const fromEnd = checked({
    value: edge.fromEnd,
    valid: isEnd,
    id,
    field: 'fromEnd',
    notes,
  });
  const toEnd = checked({
    value: edge.toEnd,
    valid: isEnd,
    id,
    field: 'toEnd',
    notes,
  });
  const color = checked({
    value: edge.color,
    valid: isCanvasColor,
    id,
    field: 'color',
    notes,
  });
  return {
    id,
    fromNode: edge.fromNode,
    toNode: edge.toNode,
    ...(fromSide === undefined ? {} : { fromSide }),
    ...(toSide === undefined ? {} : { toSide }),
    ...(fromEnd === undefined ? {} : { fromEnd }),
    ...(toEnd === undefined ? {} : { toEnd }),
    ...(edge.label === undefined ? {} : { label: edge.label }),
    ...(color === undefined ? {} : { color }),
  };
};

export interface ToJsonCanvasParams {
  readonly scene: Scene;
  readonly options?: ExportOptions;
}

// Pure. Assumes a valid scene (unique ids). Nodes are written bottom-to-top, so
// JSON Canvas array order is the scene's `order`. An edge whose endpoint did not
// make it out is dropped, so the document stays valid.
export const toJsonCanvas = ({
  scene,
  options = {},
}: ToJsonCanvasParams): ExportResult => {
  const plugins = options.plugins ?? 'placeholder';
  const notes: ExportNote[] = [];
  const nodes: JsonCanvasNode[] = [];
  for (const node of [...scene.nodes].sort(byOrder)) {
    const out = exportNode({ node, plugins, notes });
    if (out !== undefined) {
      nodes.push(out);
    }
  }
  const kept = new Set(nodes.map((n) => n.id));
  const edges: JsonCanvasEdge[] = [];
  for (const edge of scene.edges) {
    if (kept.has(edge.fromNode) && kept.has(edge.toNode)) {
      edges.push(exportEdge({ edge, notes }));
    } else {
      notes.push({
        action: 'edge-dropped',
        id: edge.id,
        detail: 'an endpoint was not exported',
      });
    }
  }
  return { canvas: { nodes, edges }, notes };
};

// --- import -----------------------------------------------------------------

export interface ImportOptions {
  // Passed in so the function stays pure: the record needs a createdAt.
  readonly createdAt: string;
  readonly title?: string;
}

const importContent = (node: JsonCanvasNode): Imported => {
  switch (node.type) {
    case 'text':
      return (
        parsePlaceholder(node.text) ?? {
          content: { $type: TEXT, text: node.text },
        }
      );
    case 'file':
      return {
        content: {
          $type: FILE,
          file: node.file,
          ...(node.subpath === undefined ? {} : { subpath: node.subpath }),
        },
      };
    case 'link':
      return { content: { $type: LINK, url: node.url } };
    case 'group':
      return {
        content: {
          $type: GROUP,
          ...(node.label === undefined ? {} : { label: node.label }),
          ...(node.background === undefined
            ? {}
            : { background: node.background }),
          ...(node.backgroundStyle === undefined
            ? {}
            : { backgroundStyle: node.backgroundStyle }),
        },
      };
  }
};

export interface FromJsonCanvasParams {
  readonly canvas: JsonCanvas;
  readonly options: ImportOptions;
}

// Pure. The four JSON Canvas types map back to text/file/link/group; a text
// node holding a placeholder envelope is restored to the node it came from.
// Array position becomes `order` (spaced by ORDER_STEP). Decode untrusted input
// with decodeJsonCanvas first.
export const fromJsonCanvas = ({
  canvas,
  options,
}: FromJsonCanvasParams): Scene => ({
  $type: SCENE_NSID,
  ...(options.title === undefined ? {} : { title: options.title }),
  nodes: (canvas.nodes ?? []).map((node, index): SceneNode => {
    const { content, ref } = importContent(node);
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      order: index * ORDER_STEP,
      ...(node.color === undefined ? {} : { color: node.color }),
      ...(ref === undefined ? {} : { ref }),
      content,
    };
  }),
  edges: canvas.edges ?? [],
  createdAt: options.createdAt,
});
