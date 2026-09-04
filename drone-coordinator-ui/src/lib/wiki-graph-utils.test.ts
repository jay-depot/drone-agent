import { describe, expect, it } from 'vitest';
import { buildFocusedSubgraph } from './wiki-graph-utils';
import type { WikiGraph } from '@/lib/types';

const graph: WikiGraph = {
  nodes: [
    { id: 'a', title: 'A', exists: true, tags: [], scope: 'coordinator' },
    { id: 'b', title: 'B', exists: true, tags: [], scope: 'coordinator' },
    { id: 'c', title: 'C', exists: true, tags: [], scope: 'coordinator' },
    { id: 'd', title: 'D', exists: true, tags: [], scope: 'coordinator' },
  ],
  edges: [
    { source: 'a', target: 'b', kind: 'link' },
    { source: 'c', target: 'a', kind: 'link' },
    { source: 'b', target: 'd', kind: 'link' },
  ],
};

describe('buildFocusedSubgraph', () => {
  it('keeps the focused node and its direct neighbors', () => {
    const sub = buildFocusedSubgraph(graph, 'a');
    const ids = sub.nodes.map(n => n.id).sort();
    // a's neighbors are b (outgoing) and c (incoming); d is a neighbor of b, not a.
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('keeps only edges touching the focused node', () => {
    const sub = buildFocusedSubgraph(graph, 'a');
    expect(sub.edges).toHaveLength(2);
    expect(sub.edges).toContainEqual({
      source: 'a',
      target: 'b',
      kind: 'link',
    });
    expect(sub.edges).toContainEqual({
      source: 'c',
      target: 'a',
      kind: 'link',
    });
  });

  it('includes incoming-neighbor pages (node linked-from-by another)', () => {
    const sub = buildFocusedSubgraph(graph, 'd');
    const ids = sub.nodes.map(n => n.id).sort();
    // b links to d, so d's neighborhood is { b, d }.
    expect(ids).toEqual(['b', 'd']);
    expect(sub.edges).toEqual([{ source: 'b', target: 'd', kind: 'link' }]);
  });

  it('returns the focused node alone when it has no edges (orphan)', () => {
    const orb: WikiGraph = {
      nodes: [
        { id: 'x', title: 'X', exists: true, tags: [], scope: 'coordinator' },
        { id: 'y', title: 'Y', exists: true, tags: [], scope: 'coordinator' },
      ],
      edges: [],
    };
    const sub = buildFocusedSubgraph(orb, 'x');
    expect(sub.nodes).toEqual([
      { id: 'x', title: 'X', exists: true, tags: [], scope: 'coordinator' },
    ]);
    expect(sub.edges).toEqual([]);
  });
});
