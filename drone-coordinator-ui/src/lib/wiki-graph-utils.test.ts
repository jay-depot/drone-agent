import { describe, expect, it } from 'vitest';
import {
  applyNodeSizing,
  buildAugmentedWikiGraph,
  buildFocusSets,
  filterOrphans,
  labelDegreeThreshold,
  wikiLinkDegrees,
  NODE_SIZE_SPREAD,
  LABEL_THRESHOLD_MAX_DEGREE,
  LABEL_THRESHOLD_MAX_ZOOM,
  LABEL_THRESHOLD_MIN_ZOOM,
} from './wiki-graph-utils';
import type {
  AugmentedGraphEdge,
  AugmentedGraphNode,
  WikiGraph,
  AugmentedWikiGraph,
} from '@/lib/types';

function pageNode(overrides: Partial<AugmentedGraphNode>): AugmentedGraphNode {
  return {
    id: 'page',
    title: 'Page',
    exists: true,
    wordCount: 0,
    tags: [],
    scope: 'coordinator',
    kind: 'page',
    ...overrides,
  };
}

describe('wikiLinkDegrees', () => {
  it('counts in and out links per node over link edges only', () => {
    const edges: AugmentedGraphEdge[] = [
      { source: 'a', target: 'b', kind: 'link' },
      { source: 'c', target: 'a', kind: 'link' },
      { source: 'b', target: 'a', kind: 'link' },
      { source: 'a', target: 'tag:x', kind: 'tag' },
      { source: 'b', target: 'tag:x', kind: 'tag' },
    ];
    const degrees = wikiLinkDegrees(edges);
    expect(degrees.get('a')).toBe(3);
    expect(degrees.get('b')).toBe(2);
    expect(degrees.get('c')).toBe(1);
    expect(degrees.has('tag:x')).toBe(false);
  });

  it('returns an empty map for no edges', () => {
    expect(wikiLinkDegrees([]).size).toBe(0);
  });
});

describe('buildAugmentedWikiGraph', () => {
  const graph: WikiGraph = {
    nodes: [
      pageNode({ id: 'a', title: 'A', tags: ['x', 'y'] }),
      pageNode({ id: 'b', title: 'B', tags: ['x'] }),
      pageNode({ id: 'c', title: 'C', tags: [] }),
    ],
    edges: [{ source: 'a', target: 'b', kind: 'link' }],
  };

  it('keeps pages with kind "page" and server edges intact', () => {
    const aug = buildAugmentedWikiGraph(graph);
    expect(aug.nodes.filter(n => n.kind === 'page').map(n => n.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(aug.edges).toContainEqual({
      source: 'a',
      target: 'b',
      kind: 'link',
    });
  });

  it('creates one tag node per unique tag with namespaced ids', () => {
    const aug = buildAugmentedWikiGraph(graph);
    const tagNodes = aug.nodes.filter(n => n.kind === 'tag');
    expect(tagNodes.map(n => n.id).sort()).toEqual(['tag:x', 'tag:y']);
    expect(tagNodes.map(n => n.title).sort()).toEqual(['x', 'y']);
    const tagX = tagNodes.find(n => n.id === 'tag:x')!;
    expect(tagX.exists).toBe(true);
    expect(tagX.wordCount).toBe(0);
    expect(tagX.tags).toEqual(['x']);
  });

  it('creates one tag edge per page-tag pair, deduplicated', () => {
    const aug = buildAugmentedWikiGraph(graph);
    const tagEdges = aug.edges.filter(e => e.kind === 'tag');
    expect(tagEdges).toEqual([
      { source: 'a', target: 'tag:x', kind: 'tag' },
      { source: 'a', target: 'tag:y', kind: 'tag' },
      { source: 'b', target: 'tag:x', kind: 'tag' },
    ]);
  });

  it('does not mutate the input graph', () => {
    const before = JSON.stringify(graph);
    buildAugmentedWikiGraph(graph);
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe('filterOrphans', () => {
  it('drops pages with zero wiki-link degree and their tag edges', () => {
    const graph: AugmentedWikiGraph = {
      nodes: [
        pageNode({ id: 'a', tags: ['x'] }),
        pageNode({ id: 'b' }),
        pageNode({ id: 'orphan', tags: ['x'] }),
        pageNode({ id: 'tag:x', title: 'x', tags: ['x'], kind: 'tag' }),
      ],
      edges: [
        { source: 'a', target: 'b', kind: 'link' },
        { source: 'a', target: 'tag:x', kind: 'tag' },
        { source: 'orphan', target: 'tag:x', kind: 'tag' },
      ],
    };
    const filtered = filterOrphans(graph);
    expect(filtered.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'tag:x']);
    expect(
      filtered.edges.sort(
        (x, y) =>
          x.kind.localeCompare(y.kind) || x.source.localeCompare(y.source)
      )
    ).toEqual([
      { source: 'a', target: 'b', kind: 'link' },
      { source: 'a', target: 'tag:x', kind: 'tag' },
    ]);
  });

  it('drops tag nodes left without any member edge', () => {
    const graph: AugmentedWikiGraph = {
      nodes: [
        pageNode({ id: 'a' }),
        pageNode({ id: 'b' }),
        pageNode({ id: 'lonely-page', tags: ['lonely'] }),
        pageNode({
          id: 'tag:lonely',
          title: 'lonely',
          tags: ['lonely'],
          kind: 'tag',
        }),
      ],
      edges: [
        { source: 'a', target: 'b', kind: 'link' },
        { source: 'lonely-page', target: 'tag:lonely', kind: 'tag' },
      ],
    };
    const filtered = filterOrphans(graph);
    expect(filtered.nodes.map(n => n.id)).toEqual(['a', 'b']);
    expect(filtered.edges).toEqual([
      { source: 'a', target: 'b', kind: 'link' },
    ]);
  });

  it('keeps broken-link placeholder pages that have link degree', () => {
    const graph: AugmentedWikiGraph = {
      nodes: [
        pageNode({ id: 'a' }),
        pageNode({ id: 'missing', title: 'missing', exists: false }),
      ],
      edges: [{ source: 'a', target: 'missing', kind: 'link' }],
    };
    const filtered = filterOrphans(graph);
    expect(filtered.nodes.map(n => n.id)).toEqual(['a', 'missing']);
  });

  it('keeps a linked page that also has no tags', () => {
    const graph: AugmentedWikiGraph = {
      nodes: [
        pageNode({ id: 'a', tags: ['x'] }),
        pageNode({ id: 'b', tags: [] }),
        pageNode({ id: 'tag:x', title: 'x', tags: ['x'], kind: 'tag' }),
      ],
      edges: [
        { source: 'a', target: 'b', kind: 'link' },
        { source: 'a', target: 'tag:x', kind: 'tag' },
      ],
    };
    const filtered = filterOrphans(graph);
    expect(filtered.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'tag:x']);
  });
});

describe('applyNodeSizing', () => {
  it('scales node value with the blend of degree and word count', () => {
    const nodes = [
      pageNode({ id: 'hub', wordCount: 3000 }),
      pageNode({ id: 'meaty', wordCount: 3000 }),
      pageNode({ id: 'sparse', wordCount: 0 }),
    ];
    const edges: AugmentedGraphEdge[] = [
      { source: 'hub', target: 'meaty', kind: 'link' },
      { source: 'hub', target: 'sparse', kind: 'link' },
      { source: 'sparse', target: 'hub', kind: 'link' },
    ];
    const sized = applyNodeSizing(nodes, edges);
    const byId = new Map(sized.map(n => [n.id, n._val ?? 0]));
    // hub: max degree (3) and max words -> importance 1.0
    expect(byId.get('hub')).toBeCloseTo(Math.pow(1 + NODE_SIZE_SPREAD, 1.5));
    // meaty: degree 1/3, words max -> 0.7*(1/3) + 0.3*1
    expect(byId.get('meaty')).toBeCloseTo(
      Math.pow(1 + NODE_SIZE_SPREAD * (0.7 / 3 + 0.3), 1.5)
    );
    // sparse: degree 2/3, words ~0 -> 0.7*(2/3)
    // (wordCount 0 keeps the words term out of the expectation)
    expect(byId.get('sparse')).toBeCloseTo(
      Math.pow(1 + NODE_SIZE_SPREAD * ((0.7 * 2) / 3), 1.5)
    );
  });

  it('returns the minimum value for every node in an all-zero graph', () => {
    const nodes = [pageNode({ id: 'x' }), pageNode({ id: 'y' })];
    const sized = applyNodeSizing(nodes, []);
    for (const node of sized) {
      expect(node._val).toBe(1);
    }
  });

  it('gives tag nodes value from their member count', () => {
    const nodes: AugmentedGraphNode[] = [
      pageNode({ id: 'a', tags: ['x'] }),
      pageNode({ id: 'b', tags: ['x'] }),
      pageNode({ id: 'c', tags: ['y'] }),
      pageNode({ id: 'tag:x', title: 'x', tags: ['x'], kind: 'tag' }),
      pageNode({ id: 'tag:y', title: 'y', tags: ['y'], kind: 'tag' }),
    ];
    const edges: AugmentedGraphEdge[] = [
      { source: 'a', target: 'tag:x', kind: 'tag' },
      { source: 'b', target: 'tag:x', kind: 'tag' },
      { source: 'c', target: 'tag:y', kind: 'tag' },
    ];
    const sized = applyNodeSizing(nodes, edges);
    const byId = new Map(sized.map(n => [n.id, n._val ?? 0]));
    expect(byId.get('tag:x')).toBeCloseTo(
      Math.pow(1 + NODE_SIZE_SPREAD * 0.7, 1.5)
    );
    expect(byId.get('tag:y')).toBeCloseTo(
      Math.pow(1 + NODE_SIZE_SPREAD * 0.35, 1.5)
    );
  });
});

describe('labelDegreeThreshold', () => {
  it('returns the max degree at or below the min zoom', () => {
    expect(labelDegreeThreshold(0.5)).toBe(LABEL_THRESHOLD_MAX_DEGREE);
    expect(labelDegreeThreshold(LABEL_THRESHOLD_MIN_ZOOM)).toBe(
      LABEL_THRESHOLD_MAX_DEGREE
    );
  });

  it('returns 0 at or above the max zoom', () => {
    expect(labelDegreeThreshold(LABEL_THRESHOLD_MAX_ZOOM)).toBe(0);
    expect(labelDegreeThreshold(5)).toBe(0);
  });

  it('interpolates linearly between the zoom endpoints', () => {
    const mid = (LABEL_THRESHOLD_MIN_ZOOM + LABEL_THRESHOLD_MAX_ZOOM) / 2;
    expect(labelDegreeThreshold(mid)).toBeCloseTo(
      LABEL_THRESHOLD_MAX_DEGREE / 2
    );
  });
});

describe('buildFocusSets', () => {
  const edges: AugmentedGraphEdge[] = [
    { source: 'a', target: 'b', kind: 'link' },
    { source: 'c', target: 'a', kind: 'link' },
    { source: 'b', target: 'd', kind: 'link' },
    { source: 'a', target: 'tag:x', kind: 'tag' },
  ];

  it('collects the focus and its direct neighbors for a page focus', () => {
    const sets = buildFocusSets(edges, 'a');
    expect([...sets.neighborIds].sort()).toEqual(['a', 'b', 'c', 'tag:x']);
    expect(sets.touchingEdges.size).toBe(3);
  });

  it('includes tag edges when the focus is a tag node', () => {
    const sets = buildFocusSets(edges, 'tag:x');
    expect([...sets.neighborIds].sort()).toEqual(['a', 'tag:x']);
    expect(sets.touchingEdges.size).toBe(1);
  });

  it('returns a lone focus for an unknown id', () => {
    const sets = buildFocusSets(edges, 'nope');
    expect([...sets.neighborIds]).toEqual(['nope']);
    expect(sets.touchingEdges.size).toBe(0);
  });
});
