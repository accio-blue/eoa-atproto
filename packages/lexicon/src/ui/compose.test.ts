import { describe, expect, it } from 'vitest';
import { COMPONENT_NSID } from './component.js';
import type { Element } from './compose.js';
import type { PublishedComponent } from './component.js';
import { resolveComposition } from './compose.js';

const STACK = 'dev.cssints.ui.stack';
const TEXT = 'dev.cssints.ui.text';

const alpha = 'did:plc:alpha';
const beta = 'did:plc:beta';
const gamma = 'did:plc:gamma';

const publisher = ({
  did,
  nsid,
  imports,
}: {
  readonly did: string;
  readonly nsid: string;
  readonly imports: readonly string[];
}): PublishedComponent => ({
  did,
  record: {
    $type: COMPONENT_NSID,
    nsid,
    imports,
    createdAt: '2026-10-08T00:00:00.000Z',
  },
});

const element = ({
  type,
  children = [],
}: {
  readonly type: string;
  readonly children?: readonly Element[];
}): Element =>
  children.length === 0 ? { type } : { type, props: { children } };

describe('resolveComposition', () => {
  it('resolves every element and preserves order and keys', () => {
    const published = [
      publisher({ did: alpha, nsid: STACK, imports: [alpha] }),
      publisher({ did: alpha, nsid: TEXT, imports: [alpha] }),
    ];
    const roots: Element[] = [
      element({
        type: STACK,
        children: [
          { key: 'title', type: TEXT },
          { key: 'body', type: TEXT },
        ],
      }),
      element({ type: TEXT }),
    ];

    const composition = resolveComposition({
      roots,
      published,
      tenantOrder: [alpha],
    });
    expect(composition.unresolved).toEqual([]);
    expect(composition.roots.map((node) => node.element.type)).toEqual([
      STACK,
      TEXT,
    ]);
    expect(
      composition.roots[0]?.children.map((node) => node.element.key),
    ).toEqual(['title', 'body']);
    expect(composition.roots[0]?.resolved?.did).toBe(alpha);
  });

  it("uses a component's own imports for its subtree, not the tenant order", () => {
    // The tenant prefers beta, but the Stack component pins gamma for its children.
    const published = [
      publisher({ did: beta, nsid: STACK, imports: [beta] }),
      publisher({ did: gamma, nsid: TEXT, imports: [gamma] }),
      publisher({ did: beta, nsid: TEXT, imports: [beta] }),
    ];
    const composition = resolveComposition({
      roots: [element({ type: STACK, children: [element({ type: TEXT })] })],
      published,
      tenantOrder: [beta, gamma],
    });

    expect(composition.roots[0]?.resolved?.did).toBe(beta);
    // Stack's own `imports` is [beta], so its child resolves to beta's Text.
    expect(composition.roots[0]?.children[0]?.resolved?.did).toBe(beta);

    const pinned = [
      publisher({ did: beta, nsid: STACK, imports: [gamma, beta] }),
      publisher({ did: gamma, nsid: TEXT, imports: [gamma] }),
      publisher({ did: beta, nsid: TEXT, imports: [beta] }),
    ];
    const pinnedComposition = resolveComposition({
      roots: [element({ type: STACK, children: [element({ type: TEXT })] })],
      published: pinned,
      tenantOrder: [beta, gamma],
    });
    expect(pinnedComposition.roots[0]?.children[0]?.resolved?.did).toBe(gamma);
  });

  it('is deny-by-default across the whole tree', () => {
    const published = [
      publisher({ did: gamma, nsid: STACK, imports: [gamma] }),
      publisher({ did: gamma, nsid: TEXT, imports: [gamma] }),
    ];
    const composition = resolveComposition({
      roots: [element({ type: STACK, children: [element({ type: TEXT })] })],
      published,
      tenantOrder: [alpha, beta],
    });
    expect(composition.roots[0]?.resolved).toBeUndefined();
    expect(composition.roots[0]?.children[0]?.resolved).toBeUndefined();
    expect(composition.unresolved).toEqual([STACK, TEXT]);
  });

  it('reports an unresolved name instead of throwing, and still walks its children', () => {
    const published = [publisher({ did: alpha, nsid: TEXT, imports: [alpha] })];
    const composition = resolveComposition({
      roots: [
        element({
          type: 'org.unknown.Widget',
          children: [element({ type: TEXT })],
        }),
      ],
      published,
      tenantOrder: [alpha],
    });
    expect(composition.unresolved).toEqual(['org.unknown.Widget']);
    expect(composition.roots[0]?.resolved).toBeUndefined();
    expect(composition.roots[0]?.children[0]?.resolved?.did).toBe(alpha);
  });

  it('ignores non-element children and stops at the depth cap', () => {
    const published = [
      publisher({ did: alpha, nsid: STACK, imports: [alpha] }),
    ];
    const noisy: Element = {
      type: STACK,
      props: {
        children: ['a string', 42, null, { notAType: true }, { type: TEXT }],
      },
    };
    const composition = resolveComposition({
      roots: [noisy],
      published,
      tenantOrder: [alpha],
    });
    expect(
      composition.roots[0]?.children.map((node) => node.element.type),
    ).toEqual([TEXT]);
    expect(composition.truncated).toBe(false);

    const deep: Element = element({
      type: STACK,
      children: [
        element({ type: STACK, children: [element({ type: STACK })] }),
      ],
    });
    const capped = resolveComposition({
      roots: [deep],
      published,
      tenantOrder: [alpha],
      options: { maxDepth: 1 },
    });
    expect(capped.truncated).toBe(true);
    expect(capped.roots[0]?.children[0]?.children).toEqual([]);
  });
});
