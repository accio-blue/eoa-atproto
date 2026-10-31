import {
  CANVAS,
  COMPONENT,
  FILE,
  GROUP,
  LINK,
  TEXT,
  byOrder,
} from './scene.js';
import type { NodeContent, Scene, SceneNode } from './scene.js';
import { Result, Schema } from 'effect';
import { rkeyOf } from './override.js';

// Structural mirror of `CanvasNodeInput` / `CanvasNodeRole` in
// `@cssints/headless` (`createCanvas`). Mirrored, not imported, so the
// lexicon package does not depend on headless; TypeScript's structural typing
// lets the result be passed straight to `createCanvas({ nodes })`.
export type CanvasNodeRoleShape =
  | 'group'
  | 'article'
  | 'figure'
  | 'listitem'
  | 'option'
  | 'treeitem'
  | 'gridcell';

export interface CanvasNodeShape {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly role?: CanvasNodeRoleShape;
  readonly roleDescription?: string;
}

// The label is spoken by a screen reader and echoed in the live region, so a
// long text note is cut to its first line and this many characters.
const MAX_LABEL = 80;

// The string fields any variant reads. Decoding (not indexing) means a scene
// from another build, with a field missing or mistyped, never makes the mapping
// throw: it just yields no field.
const Fields = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  componentUri: Schema.optionalKey(Schema.String),
  scene: Schema.optionalKey(Schema.String),
});
const decodeFields = Schema.decodeUnknownResult(Fields);
const NO_FIELDS: typeof Fields.Type = {};

const fieldsOf = (content: NodeContent): typeof Fields.Type => {
  const decoded = decodeFields(content);
  return Result.isSuccess(decoded) ? decoded.success : NO_FIELDS;
};

const nonBlank = (s: string | undefined): string | undefined =>
  s === undefined || s.trim() === '' ? undefined : s;

const clip = (s: string): string =>
  s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s;

const firstLine = (text: string): string | undefined =>
  text
    .split('\n')
    .map((line) => line.replace(/^\s*#+\s*/, '').trim())
    .find((line) => line !== '');

interface Presentation {
  readonly label: string;
  readonly role?: CanvasNodeRoleShape;
  readonly roleDescription?: string;
}

const present = (content: NodeContent): Presentation => {
  const f = fieldsOf(content);
  switch (content.$type) {
    case TEXT: {
      const line = firstLine(f.text ?? '');
      return {
        label: line === undefined ? 'Text note' : clip(line),
        role: 'article',
        roleDescription: 'text note',
      };
    }
    case FILE: {
      const name = nonBlank(f.file)?.split('/').pop();
      return {
        label: name === undefined || name === '' ? 'File' : clip(name),
        role: 'figure',
        roleDescription: 'file',
      };
    }
    case LINK: {
      const url = nonBlank(f.url);
      return {
        label: url === undefined ? 'Link' : clip(url),
        role: 'article',
        roleDescription: 'link',
      };
    }
    case GROUP: {
      const label = nonBlank(f.label);
      return {
        label: label === undefined ? 'Group' : clip(label),
        role: 'group',
        roleDescription: 'canvas group',
      };
    }
    case COMPONENT: {
      const rkey = rkeyOf(f.componentUri ?? '');
      return {
        label: rkey === undefined ? 'Component' : `Component ${rkey}`,
        role: 'figure',
        roleDescription: 'plugin component',
      };
    }
    case CANVAS: {
      const rkey = rkeyOf(f.scene ?? '');
      return {
        label: rkey === undefined ? 'Nested canvas' : `Nested canvas ${rkey}`,
        role: 'figure',
        roleDescription: 'nested canvas',
      };
    }
    // A variant this build does not know (a newer writer, or a third party's
    // NSID): still a focusable, placeable box. No role, so the consumer's
    // default applies.
    default:
      return { label: `Unsupported node (${clip(content.$type)})` };
  }
};

const toCanvasNode = (node: SceneNode): CanvasNodeShape => {
  const { id, x, y, width, height, content } = node;
  return { id, x, y, width, height, ...present(content) };
};

/**
 * A scene's nodes as `createCanvas` input, bottom of the z-order first.
 *
 * This is what feeds `createCanvas`'s index-as-z-index contract: the headless
 * canvas gives each node `z-index = its index in the array` and hit-tests the
 * highest index first, so sorting by `byOrder` makes `order` the stacking order
 * for both paint and pointer priority.
 *
 * A tie in `order` is broken by id (`byOrder`), so equal orders still converge
 * whatever the input order. Input order only decides when `order` AND id are
 * both equal, which a valid scene (unique ids) never has; the sort is stable.
 *
 * Pure; the scene is not modified. An unknown `$type` never throws, it maps to
 * a generic label.
 */
export const sceneToCanvasNodes = (scene: Scene): CanvasNodeShape[] =>
  [...scene.nodes].sort(byOrder).map(toCanvasNode);
