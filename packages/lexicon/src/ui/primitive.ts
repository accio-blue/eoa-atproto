/**
 * `ing.lexicon.ui.primitive` — a primitive's published interface.
 *
 * The record key IS the primitive NSID, so a component record or a third-party
 * plugin author can bind to a name and read what it accepts without reading our
 * TypeScript. It carries **no behaviour**: props, events, and the Mise en Mode
 * intents the primitive reads (so a host can contain a look, ADR 0002 Rule 7).
 *
 * The canonical intent list lives here so the lexicon and this mirror cannot
 * drift; `unknownIntents` is the check a host runs on a record it did not write.
 */
import type { Schema } from 'effect';

export const PRIMITIVE_NSID = 'ing.lexicon.ui.primitive';

/** The value shapes a prop may declare. `number` is a float; lexicons cannot store one, but a prop may take it. */
export const PROP_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'array',
  'object',
  'element',
  'ref',
  'function',
] as const;
export type PropType = (typeof PROP_TYPES)[number];

export const EVENT_PAYLOADS = [
  'none',
  'string',
  'integer',
  'number',
  'boolean',
  'object',
  'element',
] as const;
export type EventPayload = (typeof EVENT_PAYLOADS)[number];

/**
 * The standard's 33 intents: 21 colour (control 3, action 9, surface 9) plus
 * 12 typography (text 3 priorities x size/weight/family/lineHeight).
 */
export const LOOK_INTENTS = [
  'action.auxiliary.background',
  'action.auxiliary.border',
  'action.auxiliary.foreground',
  'action.primary.background',
  'action.primary.border',
  'action.primary.foreground',
  'action.secondary.background',
  'action.secondary.border',
  'action.secondary.foreground',
  'control.background',
  'control.border',
  'control.foreground',
  'surface.auxiliary.background',
  'surface.auxiliary.border',
  'surface.auxiliary.foreground',
  'surface.primary.background',
  'surface.primary.border',
  'surface.primary.foreground',
  'surface.secondary.background',
  'surface.secondary.border',
  'surface.secondary.foreground',
  'text.auxiliary.family',
  'text.auxiliary.lineHeight',
  'text.auxiliary.size',
  'text.auxiliary.weight',
  'text.primary.family',
  'text.primary.lineHeight',
  'text.primary.size',
  'text.primary.weight',
  'text.secondary.family',
  'text.secondary.lineHeight',
  'text.secondary.size',
  'text.secondary.weight',
] as const;
export type LookIntent = (typeof LOOK_INTENTS)[number];

export interface PropDecl {
  readonly name: string;
  readonly type: PropType;
  readonly required?: boolean;
  /** Allowed values when `type` is `string`. */
  readonly knownValues?: readonly string[];
  /** Opaque default. */
  readonly default?: Schema.Json;
  readonly description?: string;
}

export interface EventDecl {
  readonly name: string;
  readonly payload?: EventPayload;
  readonly description?: string;
}

export interface PrimitiveRecord {
  readonly $type: typeof PRIMITIVE_NSID;
  /** The primitive NSID (the record key). */
  readonly nsid: string;
  readonly props?: readonly PropDecl[];
  readonly events?: readonly EventDecl[];
  readonly lookIntents?: readonly LookIntent[];
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface DeclaresPropParams {
  readonly record: PrimitiveRecord;
  readonly name: string;
}

/** True when the record declares a prop with that name. */
export const declaresProp = ({ record, name }: DeclaresPropParams): boolean =>
  (record.props ?? []).some((prop) => prop.name === name);

export interface DeclaresEventParams {
  readonly record: PrimitiveRecord;
  readonly name: string;
}

/** True when the record declares an event with that name. */
export const declaresEvent = ({ record, name }: DeclaresEventParams): boolean =>
  (record.events ?? []).some((event) => event.name === name);

/**
 * Intent names the record uses that are not in the standard — the containment
 * check for a record this host did not write. Sorted, deduplicated; empty means
 * a look cannot paint anything the primitive did not declare.
 */
export const unknownIntents = (record: PrimitiveRecord): readonly string[] => {
  const known = new Set<string>(LOOK_INTENTS);
  return [
    ...new Set((record.lookIntents ?? []).filter((name) => !known.has(name))),
  ].sort();
};
