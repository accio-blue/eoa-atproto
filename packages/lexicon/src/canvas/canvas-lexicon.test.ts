import type { Def, DefsDoc } from '../test-utils.js';
import { Effect, Exit, Predicate } from 'effect';
import { OVERRIDE_NSID, SCENE_NSID } from './scene.js';
import { createLexicons, isLexiconDoc, validateWithLexicon } from '../index.js';
import { decodeDefsDoc, plain } from '../test-utils.js';
import { describe, expect, it } from 'vitest';
import { fromJsonCanvas, toJsonCanvas } from './json-canvas.js';
import { nestedCanvasNode, sampleScene } from './test-fixtures.js';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/canvas (this file is src/canvas).
const HOME = new URL('../../lexicons/ing/lexicon/canvas/', import.meta.url);
const NAMES = ['defs', 'scene', 'override'] as const;
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`${name}.json`, HOME)), 'utf-8');

// The toolkit's own types, for the registry and its validator.
const raw = NAMES.map((n) => parseJson(read(n)));
const docs = raw.filter(isLexiconDoc);
const lexicons = createLexicons(docs);

// A typed view of the same JSON, for walking it.
const defsDocs: DefsDoc[] = raw.map((r) => decodeDefsDoc(r));

const find = ({
  nsid,
  name = 'main',
}: {
  readonly nsid: string;
  readonly name?: string;
}): Def => {
  const def = defsDocs.find((d) => d.id === nsid)?.defs[name];
  if (def === undefined) {
    throw new Error(`no def ${nsid}#${name}`);
  }
  return def;
};
const sceneDef = find({ nsid: SCENE_NSID });
const overrideDef = find({ nsid: OVERRIDE_NSID });
const nodeDef = find({ nsid: 'ing.lexicon.canvas.defs', name: 'node' });

// What the lexicon spec lets us say; floats, blobs and cids would be a design
// change to make on purpose. https://atproto.com/specs/lexicon#overview-of-types
const ALLOWED = new Set([
  'record',
  'object',
  'array',
  'string',
  'integer',
  'boolean',
  'ref',
  'union',
  'unknown',
]);

interface Target {
  readonly nsid: string;
  readonly name: string;
  readonly def: Def | undefined;
}
const resolve = ({
  ref,
  base,
}: {
  readonly ref: string;
  readonly base: string;
}): Target => {
  const [head = '', name = 'main'] = ref.split('#');
  const nsid = head === '' ? base : head;
  return { nsid, name, def: defsDocs.find((d) => d.id === nsid)?.defs[name] };
};
const fullName = (t: Target): string =>
  t.name === 'main' ? t.nsid : `${t.nsid}#${t.name}`;

const walk = ({
  def,
  visit,
}: {
  readonly def: Def;
  readonly visit: (d: Def) => void;
}): void => {
  visit(def);
  Object.values(def.properties ?? {}).forEach((p) => walk({ def: p, visit }));
  if (def.items) {
    walk({ def: def.items, visit });
  }
  if (def.record) {
    walk({ def: def.record, visit });
  }
};

// The toolkit validates only the top-level kind of a def (lexiconToSchema), so
// record shape is checked here against the lexicon JSON itself. Rules follow
// https://atproto.com/specs/lexicon (open unions pass unknown variants; the
// `unknown` type is an object with no floats nested).
const utf8 = (s: string): number => new TextEncoder().encode(s).length;
const noFloats = (v: unknown): boolean => {
  if (typeof v === 'number') {
    return Number.isSafeInteger(v);
  }
  if (Array.isArray(v)) {
    return v.every(noFloats);
  }
  return Predicate.isObject(v) ? Object.values(v).every(noFloats) : true;
};

interface Check {
  readonly value: unknown;
  readonly def: Def;
  readonly base: string;
  readonly at?: string;
}

const reasonAt =
  (at: string) =>
  (m: string): string[] => [`${at}: ${m}`];

const conformsObject = ({ value, def, base, at = '$' }: Check): string[] => {
  if (!Predicate.isObject(value)) {
    return reasonAt(at)('not an object');
  }
  const missing = (def.required ?? [])
    .filter((key) => value[key] === undefined)
    .map((key) => `${at}: missing ${key}`);
  const nested = Object.entries(def.properties ?? {}).flatMap(([key, sub]) =>
    value[key] === undefined
      ? []
      : conforms({ value: value[key], def: sub, base, at: `${at}.${key}` }),
  );
  return [...missing, ...nested];
};

const conformsString = ({ value, def, at = '$' }: Check): string[] => {
  const bad = reasonAt(at);
  if (typeof value !== 'string') {
    return bad('not a string');
  }
  const n = utf8(value);
  const errors: string[] = [];
  if (def.minLength !== undefined && n < def.minLength) {
    errors.push(...bad('too short'));
  }
  if (def.maxLength !== undefined && n > def.maxLength) {
    errors.push(...bad('too long'));
  }
  if (def.format === 'at-uri' && !value.startsWith('at://')) {
    errors.push(...bad('not an at-uri'));
  }
  if (def.format === 'uri' && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    errors.push(...bad('not a uri'));
  }
  if (
    def.format === 'datetime' &&
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(value)
  ) {
    errors.push(...bad('not a datetime'));
  }
  return errors;
};

const conformsUnion = ({ value, def, base, at = '$' }: Check): string[] => {
  const bad = reasonAt(at);
  const type = Predicate.isObject(value) ? value['$type'] : undefined;
  if (typeof type !== 'string') {
    return bad('union variant without $type');
  }
  const target = (def.refs ?? [])
    .map((ref) => resolve({ ref, base }))
    .find((t) => fullName(t) === type);
  if (target?.def === undefined) {
    return def.closed === true ? bad(`closed union has no ${type}`) : [];
  }
  return conforms({ value, def: target.def, base: target.nsid, at });
};

const conformsArray = ({ value, def, base, at = '$' }: Check): string[] => {
  const items = def.items;
  return Array.isArray(value) && items
    ? value.flatMap((v, i) =>
        conforms({ value: v, def: items, base, at: `${at}[${i}]` }),
      )
    : reasonAt(at)('not an array');
};

const conformsInteger = ({ value, def, at = '$' }: Check): string[] =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= (def.minimum ?? -Infinity) &&
  value <= (def.maximum ?? Infinity)
    ? []
    : reasonAt(at)('not an integer in range');

const conformsRef = ({ value, def, base, at = '$' }: Check): string[] => {
  const target = resolve({ ref: def.ref ?? '', base });
  return target.def
    ? conforms({ value, def: target.def, base: target.nsid, at })
    : reasonAt(at)('dangling ref');
};

const conforms = (check: Check): string[] => {
  const { value, def, base, at = '$' } = check;
  const bad = reasonAt(at);
  switch (def.type) {
    case 'record':
      return conforms({ value, def: def.record ?? { type: 'none' }, base, at });
    case 'object':
      return conformsObject(check);
    case 'array':
      return conformsArray(check);
    case 'string':
      return conformsString(check);
    case 'integer':
      return conformsInteger(check);
    case 'boolean':
      return typeof value === 'boolean' ? [] : bad('not a boolean');
    case 'unknown':
      return Predicate.isObject(value) && noFloats(value)
        ? []
        : bad('not a float-free object');
    case 'ref':
      return conformsRef(check);
    case 'union':
      return conformsUnion(check);
    default:
      return bad(`unsupported def ${def.type}`);
  }
};

describe('ing.lexicon.canvas lexicons', () => {
  it('are lexicon docs the toolkit registry accepts, one per file', () => {
    expect(raw.every((d) => isLexiconDoc(d) && d.lexicon === 1)).toBe(true);
    expect(lexicons.ids).toEqual([
      'ing.lexicon.canvas.defs',
      SCENE_NSID,
      OVERRIDE_NSID,
    ]);
  });

  it('use record keys: tid for the scene, any for the override (rkey = scene rkey)', () => {
    expect(sceneDef.type).toBe('record');
    expect(sceneDef.key).toBe('tid');
    expect(overrideDef.type).toBe('record');
    expect(overrideDef.key).toBe('any');
  });

  it('use only the lexicon types we allow, and every ref and union ref resolves', () => {
    for (const doc of defsDocs) {
      for (const def of Object.values(doc.defs)) {
        walk({
          def,
          visit: (d) => {
            expect(ALLOWED.has(d.type), `${doc.id}: ${d.type}`).toBe(true);
            expect(
              (d.required ?? []).every((k) =>
                Object.hasOwn(d.properties ?? {}, k),
              ),
              `${doc.id}: required not in properties`,
            ).toBe(true);
            for (const r of [...(d.ref ? [d.ref] : []), ...(d.refs ?? [])]) {
              expect(
                resolve({ ref: r, base: doc.id }).def,
                `${doc.id}: ${r}`,
              ).toBeDefined();
            }
          },
        });
      }
    }
  });

  it('keep the node content union open, so third parties can add variants', () => {
    expect(nodeDef.properties?.['content']?.type).toBe('union');
    expect(nodeDef.properties?.['content']?.closed).toBe(false);
  });

  it('list #canvas among the content variants, with a required at-uri scene', () => {
    const canvasDef = find({ nsid: 'ing.lexicon.canvas.defs', name: 'canvas' });

    expect(nodeDef.properties?.['content']?.refs).toContain('#canvas');
    expect(canvasDef.required).toEqual(['scene']);
    expect(canvasDef.properties?.['scene']).toMatchObject({
      type: 'string',
      format: 'at-uri',
    });
  });

  it('make every geometry field an integer, which the toolkit enforces', async () => {
    for (const field of ['x', 'y', 'width', 'height', 'order']) {
      const type = nodeDef.properties?.[field]?.type ?? 'missing';
      expect(type).toBe('integer');
      const run = (n: number) =>
        Effect.runPromiseExit(
          validateWithLexicon({ data: n, lexicon: { type } }),
        );
      expect(Exit.isSuccess(await run(3))).toBe(true);
      expect(Exit.isFailure(await run(1.5))).toBe(true);
    }
  });
});

describe('scenes and overrides against the lexicon', () => {
  it('accept the sample scene, plugin and unknown variant included', () => {
    expect(
      conforms({ value: plain(sampleScene), def: sceneDef, base: SCENE_NSID }),
    ).toEqual([]);
  });

  it('accept a nested canvas node, and reject one without a scene or with a bad uri', () => {
    const withContent = (content: unknown) => ({
      ...plain(sampleScene),
      nodes: [{ ...plain(nestedCanvasNode), content }],
    });
    const type = 'ing.lexicon.canvas.defs#canvas';

    expect(
      conforms({
        value: { ...plain(sampleScene), nodes: [plain(nestedCanvasNode)] },
        def: sceneDef,
        base: SCENE_NSID,
      }),
    ).toEqual([]);
    expect(
      conforms({
        value: withContent({ $type: type }),
        def: sceneDef,
        base: SCENE_NSID,
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: withContent({ $type: type, scene: 'https://example.com/scene' }),
        def: sceneDef,
        base: SCENE_NSID,
      }),
    ).not.toEqual([]);
  });

  it('accept a scene imported from JSON Canvas', () => {
    const imported = fromJsonCanvas({
      canvas: toJsonCanvas({ scene: sampleScene }).canvas,
      options: { createdAt: sampleScene.createdAt },
    });

    expect(
      conforms({ value: plain(imported), def: sceneDef, base: SCENE_NSID }),
    ).toEqual([]);
  });

  it('reject a float coordinate, a missing order, a float in props', () => {
    const first = plain(sampleScene.nodes[0]);
    const withNode = (patch: Record<string, unknown>) => ({
      ...plain(sampleScene),
      nodes: [{ ...first, ...patch }],
    });
    const component = (props: unknown) => ({
      $type: 'ing.lexicon.canvas.defs#component',
      componentUri: 'at://did:plc:abc123/at.inlay.component/3kcomp',
      props,
    });

    expect(
      conforms({
        value: withNode({ x: 1.5 }),
        def: sceneDef,
        base: SCENE_NSID,
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: withNode({ order: undefined }),
        def: sceneDef,
        base: SCENE_NSID,
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: withNode({ content: component({ p: 0.5 }) }),
        def: sceneDef,
        base: SCENE_NSID,
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: withNode({ content: component({ p: 5 }) }),
        def: sceneDef,
        base: SCENE_NSID,
      }),
    ).toEqual([]);
  });

  it('accept an override that patches some fields, and reject a bad one', () => {
    const override = {
      $type: OVERRIDE_NSID,
      scene: 'at://did:plc:abc123/ing.lexicon.canvas.scene/3kscene',
      nodes: [{ id: 't1', x: 12, y: -4, hidden: true }],
      createdAt: sampleScene.createdAt,
    };

    expect(
      conforms({ value: override, def: overrideDef, base: OVERRIDE_NSID }),
    ).toEqual([]);
    expect(
      conforms({
        value: { ...override, nodes: [{ id: 't1', x: 0.5 }] },
        def: overrideDef,
        base: OVERRIDE_NSID,
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: { ...override, scene: undefined },
        def: overrideDef,
        base: OVERRIDE_NSID,
      }),
    ).not.toEqual([]);
  });
});
