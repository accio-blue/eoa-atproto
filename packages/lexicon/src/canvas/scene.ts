import type { Schema } from 'effect';

// Hand-typed from lexicons/ing/lexicon/canvas/*.json; the lexicon test walks
// the JSON against sample scenes so the two cannot drift silently.

export const SCENE_NSID = 'ing.lexicon.canvas.scene';
export const OVERRIDE_NSID = 'ing.lexicon.canvas.override';

export const TEXT = 'ing.lexicon.canvas.defs#text';
export const FILE = 'ing.lexicon.canvas.defs#file';
export const LINK = 'ing.lexicon.canvas.defs#link';
export const GROUP = 'ing.lexicon.canvas.defs#group';
export const COMPONENT = 'ing.lexicon.canvas.defs#component';
export const CANVAS = 'ing.lexicon.canvas.defs#canvas';

export interface TextContent {
  readonly $type: typeof TEXT;
  readonly text: string;
}

export interface FileContent {
  readonly $type: typeof FILE;
  readonly file: string;
  readonly subpath?: string;
}

export interface LinkContent {
  readonly $type: typeof LINK;
  readonly url: string;
}

export interface GroupContent {
  readonly $type: typeof GROUP;
  readonly label?: string;
  readonly background?: string;
  readonly backgroundStyle?: string;
}

export interface ComponentContent {
  readonly $type: typeof COMPONENT;
  readonly componentUri: string;
  readonly props?: { readonly [key: string]: Schema.Json };
}

// A nested scene, by at-uri.
export interface CanvasContent {
  readonly $type: typeof CANVAS;
  readonly scene: string;
}

// The open-union escape hatch: a variant under another NSID that this build
// does not know. Kept verbatim so it survives a read-modify-write.
export interface UnknownContent {
  readonly $type: string;
  readonly [key: string]: Schema.Json;
}

export type NodeContent =
  | TextContent
  | FileContent
  | LinkContent
  | GroupContent
  | ComponentContent
  | CanvasContent
  | UnknownContent;

export interface SceneNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly order: number;
  readonly color?: string;
  readonly ref?: string;
  readonly content: NodeContent;
}

export interface SceneEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly fromSide?: string;
  readonly toSide?: string;
  readonly fromEnd?: string;
  readonly toEnd?: string;
  readonly label?: string;
  readonly color?: string;
}

export interface Scene {
  readonly $type: typeof SCENE_NSID;
  readonly title?: string;
  readonly description?: string;
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface NodeOverride {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly order?: number;
  readonly hidden?: boolean;
}

export interface SceneOverride {
  readonly $type: typeof OVERRIDE_NSID;
  readonly scene: string;
  readonly nodes: readonly NodeOverride[];
  readonly createdAt: string;
  readonly updatedAt?: string;
}

// Gap left between imported nodes so an insert does not renumber its neighbours.
export const ORDER_STEP = 1024;

// Bottom-to-top draw order: `order`, then id, so equal orders still converge.
// An Array#sort comparator takes two arguments by contract, so a single object
// parameter is not an option here.
// oxlint-disable-next-line automation/no-multiple-function-params
export const byOrder = (a: SceneNode, b: SceneNode): number =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
