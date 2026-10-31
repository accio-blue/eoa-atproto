import { AGENT_ENDPOINT_NSID, AGENT_ENDPOINT_RKEY } from './endpoint.js';
import { AGENT_PROFILE_NSID, AGENT_PROFILE_RKEY } from './profile.js';
import { AGENT_PROVENANCE_NSID, AGENT_PROVENANCE_RKEY } from './provenance.js';
import type { Def, DefsDoc } from '../test-utils.js';
import { Effect, Exit, Predicate } from 'effect';
import { createLexicons, isLexiconDoc, validateWithLexicon } from '../index.js';
import { decodeDefsDoc, plain } from '../test-utils.js';
import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITY_NSID } from './capability.js';
import type { Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/agent (this file is src/agent).
const HOME = new URL('../../lexicons/ing/lexicon/agent/', import.meta.url);
const NAMES = ['profile', 'capability', 'provenance', 'endpoint'] as const;
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`${name}.json`, HOME)), 'utf-8');

const raw = NAMES.map((n) => parseJson(read(n)));
const docs = raw.filter(isLexiconDoc);
// A typed view of the JSON, for walking it (the same shape canvas uses).
const defsDocs: DefsDoc[] = raw.map((r) => decodeDefsDoc(r));
const lexicons = createLexicons(docs);

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

// The lexicon types these records are allowed to use.
const ALLOWED = new Set([
  'record',
  'object',
  'array',
  'string',
  'integer',
  'boolean',
  'unknown',
]);

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
  readonly at?: string;
}

const reasonAt =
  (at: string) =>
  (m: string): string[] => [`${at}: ${m}`];

const conformsObject = ({ value, def, at = '$' }: Check): string[] => {
  if (!Predicate.isObject(value)) {
    return reasonAt(at)('not an object');
  }
  const missing = (def.required ?? [])
    .filter((key) => value[key] === undefined)
    .map((key) => `${at}: missing ${key}`);
  const nested = Object.entries(def.properties ?? {}).flatMap(([key, sub]) =>
    value[key] === undefined
      ? []
      : conforms({ value: value[key], def: sub, at: `${at}.${key}` }),
  );
  return [...missing, ...nested];
};

// The toolkit only validates a def's top-level kind, so record shape is checked
// here against the JSON itself (https://atproto.com/specs/lexicon).
const conforms = (check: Check): string[] => {
  const { value, def, at = '$' } = check;
  const bad = reasonAt(at);
  switch (def.type) {
    case 'record':
      return conforms({ value, def: def.record ?? { type: 'none' }, at });
    case 'object':
      return conformsObject(check);
    case 'array': {
      const items = def.items;
      return Array.isArray(value) && items
        ? value.flatMap((v, i) =>
            conforms({ value: v, def: items, at: `${at}[${i}]` }),
          )
        : bad('not an array');
    }
    case 'string':
      if (typeof value !== 'string') {
        return bad('not a string');
      }
      return def.format === 'did' && !value.startsWith('did:')
        ? bad('not a did')
        : [];
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? []
        : bad('not an integer');
    case 'boolean':
      return typeof value === 'boolean' ? [] : bad('not a boolean');
    case 'unknown':
      return Predicate.isObject(value) && noFloats(value)
        ? []
        : bad('not a float-free object');
    default:
      return bad(`unsupported def ${def.type}`);
  }
};

const createdAt = '2026-10-07T00:00:00.000Z';
const sampleProfile = {
  $type: AGENT_PROFILE_NSID,
  name: 'Link',
  description: 'an agent',
  createdAt,
};
const sampleCapability = {
  $type: AGENT_CAPABILITY_NSID,
  name: 'resolve-scene',
  inputSchema: { theme: 'night-sky' },
  createdAt,
};
const sampleProvenance = {
  $type: AGENT_PROVENANCE_NSID,
  account: 'did:plc:owner',
  operator: 'Atmosphere',
  createdAt,
};
const sampleEndpoint = {
  $type: AGENT_ENDPOINT_NSID,
  acp: {
    transport: 'websocket',
    url: 'wss://agents.example/acp',
    protocolVersion: 2,
  },
  mcpServers: [
    { serverId: 'atmosphere-design-system', name: 'Atmosphere design system' },
  ],
  createdAt,
};

describe('ing.lexicon.agent lexicons', () => {
  it('are lexicon docs the toolkit registry accepts, one per file', () => {
    expect(raw.every((d) => isLexiconDoc(d) && d.lexicon === 1)).toBe(true);
    expect(lexicons.ids).toEqual([
      AGENT_PROFILE_NSID,
      AGENT_CAPABILITY_NSID,
      AGENT_PROVENANCE_NSID,
      AGENT_ENDPOINT_NSID,
    ]);
  });

  it('key the singletons by literal self and the capabilities by tid', () => {
    expect(find({ nsid: AGENT_PROFILE_NSID }).key).toBe('literal:self');
    expect(find({ nsid: AGENT_PROVENANCE_NSID }).key).toBe('literal:self');
    expect(find({ nsid: AGENT_ENDPOINT_NSID }).key).toBe('literal:self');
    expect(find({ nsid: AGENT_CAPABILITY_NSID }).key).toBe('tid');
    expect(AGENT_PROFILE_RKEY).toBe('self');
    expect(AGENT_PROVENANCE_RKEY).toBe('self');
    expect(AGENT_ENDPOINT_RKEY).toBe('self');
  });

  it('use only the allowed types, and every required key is a property', () => {
    for (const doc of defsDocs) {
      for (const def of Object.values(doc.defs)) {
        expect(ALLOWED.has(def.type), `${doc.id}: ${def.type}`).toBe(true);
        expect(
          (def.required ?? []).every((k) =>
            Object.hasOwn(def.properties ?? {}, k),
          ),
          `${doc.id}: required not in properties`,
        ).toBe(true);
      }
    }
  });

  it('the toolkit accepts an object record body and rejects a non-object', async () => {
    // `lexiconToSchema` decodes a `record` def as Unknown, so the toolkit
    // integration is exercised on the body the record carries.
    const bodyType = find({ nsid: AGENT_PROFILE_NSID }).record?.type ?? 'none';
    const run = (value: Schema.Json) =>
      Effect.runPromiseExit(
        validateWithLexicon({ data: value, lexicon: { type: bodyType } }),
      );
    expect(Exit.isSuccess(await run(sampleProfile))).toBe(true);
    expect(Exit.isFailure(await run(42))).toBe(true);
  });

  it('accept the sample records, and reject missing required / bad types', () => {
    expect(
      conforms({
        value: plain(sampleProfile),
        def: find({ nsid: AGENT_PROFILE_NSID }),
      }),
    ).toEqual([]);
    expect(
      conforms({
        value: plain(sampleCapability),
        def: find({ nsid: AGENT_CAPABILITY_NSID }),
      }),
    ).toEqual([]);
    expect(
      conforms({
        value: plain(sampleProvenance),
        def: find({ nsid: AGENT_PROVENANCE_NSID }),
      }),
    ).toEqual([]);
    expect(
      conforms({
        value: plain(sampleEndpoint),
        def: find({ nsid: AGENT_ENDPOINT_NSID }),
      }),
    ).toEqual([]);

    expect(
      conforms({
        value: { ...plain(sampleProfile), name: undefined },
        def: find({ nsid: AGENT_PROFILE_NSID }),
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: { ...plain(sampleCapability), name: 7 },
        def: find({ nsid: AGENT_CAPABILITY_NSID }),
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: { ...plain(sampleProvenance), account: 'not-a-did' },
        def: find({ nsid: AGENT_PROVENANCE_NSID }),
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: { ...plain(sampleCapability), inputSchema: { p: 0.5 } },
        def: find({ nsid: AGENT_CAPABILITY_NSID }),
      }),
    ).not.toEqual([]);
    expect(
      conforms({
        value: { ...plain(sampleEndpoint), acp: undefined },
        def: find({ nsid: AGENT_ENDPOINT_NSID }),
      }),
    ).not.toEqual([]);
  });
});
