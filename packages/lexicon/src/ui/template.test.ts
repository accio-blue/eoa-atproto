import { describe, expect, it } from 'vitest';
import { nonDataNodes } from './template.js';

describe('nonDataNodes', () => {
  it('accepts a data-only tree, nested children included', () => {
    expect(
      nonDataNodes({
        type: 'ing.lexicon.ui.card',
        key: 'c1',
        props: {
          title: 'Hello',
          count: 3,
          visible: true,
          nothing: null,
          meta: { tags: ['a', 'b'], nested: { ok: true } },
          children: [
            { type: 'ing.lexicon.ui.button', props: { label: 'Go' } },
            { type: 'ing.lexicon.ui.text', props: { children: [] } },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('rejects a root that is not an element', () => {
    expect(nonDataNodes('not an element')).toEqual(['$']);
    expect(nonDataNodes([{ type: 'ing.lexicon.ui.box' }])).toEqual(['$']);
    expect(nonDataNodes(null)).toEqual(['$']);
  });

  it('requires `type` to be an NSID', () => {
    expect(nonDataNodes({ type: 'div' })).toEqual(['$.type']);
    expect(nonDataNodes({ type: 42 })).toEqual(['$.type']);
    expect(nonDataNodes({})).toEqual(['$.type']);
  });

  it('requires `key` to be a string when it is present', () => {
    expect(nonDataNodes({ type: 'ing.lexicon.ui.box', key: 7 })).toEqual([
      '$.key',
    ]);
  });

  it('rejects a prop that is not JSON data', () => {
    expect(
      nonDataNodes({
        type: 'ing.lexicon.ui.box',
        props: { onClick: () => undefined },
      }),
    ).toEqual(['$.props.onClick']);
    expect(
      nonDataNodes({ type: 'ing.lexicon.ui.box', props: { when: new Date() } }),
    ).toEqual(['$.props.when']);
    expect(
      nonDataNodes({
        type: 'ing.lexicon.ui.box',
        props: { ratio: Number.NaN },
      }),
    ).toEqual(['$.props.ratio']);
    expect(
      nonDataNodes({
        type: 'ing.lexicon.ui.box',
        props: { missing: undefined },
      }),
    ).toEqual(['$.props.missing']);
  });

  it('rejects `props` itself when it is not a plain object', () => {
    expect(
      nonDataNodes({ type: 'ing.lexicon.ui.box', props: new Date() }),
    ).toEqual(['$.props']);
  });

  it('requires `children` to be an array of elements', () => {
    expect(
      nonDataNodes({ type: 'ing.lexicon.ui.box', props: { children: 'nope' } }),
    ).toEqual(['$.props.children']);
    expect(
      nonDataNodes({
        type: 'ing.lexicon.ui.box',
        props: { children: [{ type: 'ing.lexicon.ui.a' }, 'not an element'] },
      }),
    ).toEqual(['$.props.children[1]']);
  });

  it('reports the path of a bad prop on a nested child', () => {
    expect(
      nonDataNodes({
        type: 'ing.lexicon.ui.box',
        props: {
          children: [
            {
              type: 'ing.lexicon.ui.box',
              props: {
                children: [
                  {
                    type: 'ing.lexicon.ui.box',
                    props: { onClick: () => 1 },
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual(['$.props.children[0].props.children[0].props.onClick']);
  });

  it('reports a cycle instead of recursing forever', () => {
    const node: { type: string; props?: { children?: unknown[] } } = {
      type: 'ing.lexicon.ui.box',
    };
    node.props = { children: [node] };

    expect(nonDataNodes(node)).toEqual(['$.props.children[0]']);
  });

  it('allows the same element twice (a shared node is not a cycle)', () => {
    const shared = { type: 'ing.lexicon.ui.button' };

    expect(
      nonDataNodes({
        type: 'ing.lexicon.ui.box',
        props: { children: [shared, shared] },
      }),
    ).toEqual([]);
  });

  it('sorts and deduplicates the offenders', () => {
    expect(
      nonDataNodes({
        type: 'div',
        props: { b: undefined, onClick: () => 1 },
      }),
    ).toEqual(['$.props.b', '$.props.onClick', '$.type']);
  });
});
