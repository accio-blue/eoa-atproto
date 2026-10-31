import {
  type VisibilityGateFields,
  gateInit,
  gateLookup,
  gateSetExpired,
  gateSetGrant,
  gateSetSelectorOk,
  gateSetSubjectMatchesViewer,
  gateSetVisibility,
  idleGate,
  visibilityGateStep,
} from './visibility-gate.js';
import { defineDriver, run, stateCheck } from '@quint-machine/connect';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The differential test for the gate: `quint run` traces from the spec,
 * replayed against `visibility-gate.ts` and compared to the model - including
 * `PublicNeverHidden`, `PrivateRequiresGrant` (the fail-closed half) and
 * `NoDecisionWithoutLookup`.
 */

const string: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'appview',
    validate: (value) =>
      typeof value === 'string'
        ? { value }
        : { issues: [{ message: `expected string, got ${typeof value}` }] },
  },
};

const boolean: StandardSchemaV1<unknown, boolean> = {
  '~standard': {
    version: 1,
    vendor: 'appview',
    validate: (value) =>
      typeof value === 'boolean'
        ? { value }
        : { issues: [{ message: `expected boolean, got ${typeof value}` }] },
  },
};

const driver = defineDriver(
  {
    init: {},
    setVisibility: { v: string },
    setGrant: { g: string },
    setSubjectMatchesViewer: { b: boolean },
    setSelectorOk: { b: boolean },
    setExpired: { b: boolean },
    lookup: {},
  },
  () => {
    const gate = { fields: idleGate() } satisfies {
      fields: VisibilityGateFields;
    };
    const step = (event: Parameters<typeof visibilityGateStep>[0]['event']) => {
      gate.fields = visibilityGateStep({ fields: gate.fields, event });
    };

    return {
      init: async () => step(gateInit()),
      setVisibility: async ({ v }) => step(gateSetVisibility({ v })),
      setGrant: async ({ g }) => step(gateSetGrant({ g })),
      setSubjectMatchesViewer: async ({ b }) =>
        step(gateSetSubjectMatchesViewer({ matches: b })),
      setSelectorOk: async ({ b }) => step(gateSetSelectorOk({ ok: b })),
      setExpired: async ({ b }) => step(gateSetExpired({ expired: b })),
      lookup: async () => step(gateLookup()),
      getState: () => gate.fields,
    };
  },
);

describe('the visibility gate (differential, against the spec)', () => {
  it('agrees with the model across replays of the spec', async () => {
    const result = await run({
      spec: new URL(
        '../../specs/specs/backlink-index/visibility-gate.qnt',
        import.meta.url,
      ).pathname,
      nTraces: 12,
      maxSteps: 20,
      seed: '868686',
      driver,
      stateCheck: stateCheck(
        (raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              visibility: Schema.String,
              grant: Schema.String,
              subjectMatchesViewer: Schema.Boolean,
              selectorOk: Schema.Boolean,
              expired: Schema.Boolean,
              requested: Schema.Boolean,
              decision: Schema.String,
            }),
          )(raw),
        (spec, impl) =>
          spec.visibility === impl.visibility &&
          spec.grant === impl.grant &&
          spec.subjectMatchesViewer === impl.subjectMatchesViewer &&
          spec.selectorOk === impl.selectorOk &&
          spec.expired === impl.expired &&
          spec.requested === impl.requested &&
          spec.decision === impl.decision,
      ),
    });

    expect(result.tracesReplayed).toBe(12);
  }, 60_000);
});
