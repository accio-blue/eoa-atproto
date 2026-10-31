import {
  COMPONENT_NSID,
  resolutionOrderFor,
  resolveComponent,
} from './component.js';
import type { ComponentRecord, PublishedComponent } from './component.js';
import { createLexicons, isLexiconDoc } from '../index.js';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../json.js';
import { readFileSync } from 'node:fs';

// Home: packages/lexicon/lexicons/ing/lexicon/ui (this file is src/ui).
const HOME = new URL('../../lexicons/ing/lexicon/ui/', import.meta.url);
const ViewSchema = Schema.Struct({
  id: Schema.String,
  defs: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      key: Schema.optionalKey(Schema.String),
    }),
  ),
});
const raw = parseJson(
  readFileSync(fileURLToPath(new URL('component.json', HOME)), 'utf-8'),
);
const doc = Schema.decodeUnknownSync(ViewSchema)(raw);
const lexiconDocs = [raw].filter(isLexiconDoc);

const NSID = 'dev.cssints.ui.stack';
const record = ({
  did,
  nsid,
  patch = {},
}: {
  readonly did: string;
  readonly nsid: string;
  readonly patch?: Partial<ComponentRecord>;
}): PublishedComponent => ({
  did,
  record: {
    $type: COMPONENT_NSID,
    nsid,
    imports: [did],
    body: {
      $type: 'ing.lexicon.ui.component#bodyExternal',
      did: 'did:web:renderer',
    },
    createdAt: '2026-10-08T00:00:00.000Z',
    ...patch,
  },
});

const alpha = 'did:plc:alpha';
const beta = 'did:plc:beta';
const gamma = 'did:plc:gamma';

describe('the component record', () => {
  it('is a lexicon doc the toolkit registry accepts', () => {
    expect(isLexiconDoc(raw)).toBe(true);
    expect(createLexicons(lexiconDocs)).toBeDefined();
    expect(doc.id).toBe(COMPONENT_NSID);
  });

  it('keys the record by the NSID it implements, Inlay-shaped', () => {
    expect(doc.defs.main?.type).toBe('record');
    expect(doc.defs.main?.key).toBe('nsid');
  });
});

describe('resolveComponent', () => {
  it('returns the first publisher in the order', () => {
    const published = [
      record({ did: alpha, nsid: NSID }),
      record({ did: beta, nsid: NSID }),
    ];
    expect(
      resolveComponent({ nsid: NSID, published, order: [beta, alpha] })?.did,
    ).toBe(beta);
    expect(
      resolveComponent({ nsid: NSID, published, order: [alpha, beta] })?.did,
    ).toBe(alpha);
  });

  it('ignores a publisher that is not in the order', () => {
    const published = [
      record({ did: gamma, nsid: NSID }),
      record({ did: beta, nsid: NSID }),
    ];
    expect(
      resolveComponent({ nsid: NSID, published, order: [alpha, beta] })?.did,
    ).toBe(beta);
    expect(
      resolveComponent({ nsid: NSID, published, order: [alpha] }),
    ).toBeUndefined();
  });

  it('returns undefined when nobody publishes the NSID', () => {
    expect(
      resolveComponent({
        nsid: 'dev.cssints.ui.missing',
        published: [record({ did: alpha, nsid: NSID })],
        order: [alpha],
      }),
    ).toBeUndefined();
  });

  it('rejects two records from one DID for one NSID', () => {
    const published = [
      record({ did: alpha, nsid: NSID }),
      record({ did: alpha, nsid: NSID }),
    ];
    expect(() =>
      resolveComponent({ nsid: NSID, published, order: [alpha] }),
    ).toThrow(/two .* records/);
  });

  it('hands back the whole record, body and view included', () => {
    const view = {
      prop: 'uri',
      accepts: [{ collection: 'app.bsky.actor.profile' }],
    };
    const winner = resolveComponent({
      nsid: NSID,
      published: [record({ did: alpha, nsid: NSID, patch: { view } })],
      order: [alpha],
    });
    expect(winner?.record.view).toEqual(view);
    expect(winner?.record.body?.$type).toBe(
      'ing.lexicon.ui.component#bodyExternal',
    );
  });
});

describe('resolutionOrderFor', () => {
  it("prefers a component's own import stack over the tenant order", () => {
    const component = record({
      did: alpha,
      nsid: NSID,
      patch: { imports: [gamma, beta] },
    });
    expect(
      resolutionOrderFor({
        record: component.record,
        tenantOrder: [alpha, beta],
      }),
    ).toEqual([gamma, beta]);
  });

  it('falls back to the tenant order when the stack is empty', () => {
    expect(
      resolutionOrderFor({
        record: { imports: [] },
        tenantOrder: [alpha, beta],
      }),
    ).toEqual([alpha, beta]);
    expect(
      resolutionOrderFor({ record: undefined, tenantOrder: [alpha] }),
    ).toEqual([alpha]);
  });
});
