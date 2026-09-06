import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AugmentedGraphEdge, AugmentedGraphNode } from '@/lib/types';
import WikiGraphView, { type ForceGraphHandle } from './wiki-graph';

function makeFakeHandle() {
  const handle = {} as ForceGraphHandle &
    Record<string, ReturnType<typeof vi.fn>>;
  const chain = () => handle as unknown as ForceGraphHandle;
  for (const method of [
    'graphData',
    'nodeId',
    'linkSource',
    'linkTarget',
    'nodeRelSize',
    'nodeVal',
    'nodeColor',
    'nodeCanvasObject',
    'nodeCanvasObjectMode',
    'nodeLabel',
    'linkDirectionalArrowLength',
    'linkDirectionalArrowColor',
    'linkWidth',
    'linkColor',
    'linkLineDash',
    'onNodeClick',
    'onBackgroundClick',
    'onZoom',
    'onEngineStop',
    'width',
    'height',
    'zoom',
    'centerAt',
    'zoomToFit',
    'd3Force',
  ]) {
    handle[method] = vi.fn(chain);
  }
  const linkForce = { distance: vi.fn() };
  const chargeForce = { strength: vi.fn() };
  handle.d3Force = vi.fn((name: string) =>
    name === 'link' ? linkForce : name === 'charge' ? chargeForce : undefined
  ) as unknown as typeof handle.d3Force;
  handle._destructor = vi.fn();
  return handle;
}

function pageNode(
  overrides: Partial<AugmentedGraphNode> & { x?: number; y?: number }
): AugmentedGraphNode & { x?: number; y?: number } {
  return {
    id: 'page',
    title: 'Page',
    exists: true,
    wordCount: 10,
    tags: [],
    scope: 'coordinator',
    kind: 'page',
    ...overrides,
  };
}

const nodes: (AugmentedGraphNode & { x?: number; y?: number })[] = [
  pageNode({ id: 'a', title: 'A', x: 10, y: 20 }),
  pageNode({ id: 'b', title: 'B' }),
  pageNode({ id: 'missing', title: 'missing', exists: false }),
  pageNode({ id: 'c', title: 'C' }),
  pageNode({ id: 'tag:x', title: 'x', tags: ['x'], kind: 'tag' }),
];
const edges: AugmentedGraphEdge[] = [
  { source: 'a', target: 'b', kind: 'link' },
  { source: 'a', target: 'missing', kind: 'link' },
  { source: 'd', target: 'e', kind: 'link' },
  { source: 'a', target: 'tag:x', kind: 'tag' },
];

describe('WikiGraphView', () => {
  let handle: ReturnType<typeof makeFakeHandle>;

  beforeEach(() => {
    handle = makeFakeHandle();
    document.documentElement.classList.remove('dark');
  });

  const renderView = (
    props: Partial<Parameters<typeof WikiGraphView>[0]> = {}
  ) =>
    render(
      <WikiGraphView
        nodes={nodes}
        edges={edges}
        tagsVisible={true}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
        {...props}
      />
    );

  const accessorFrom = (method: string, callIndex = 0) => {
    const calls = (handle[method] as ReturnType<typeof vi.fn>).mock.calls;
    return calls[callIndex]?.[0] as (...args: unknown[]) => unknown;
  };

  it('instantiates the graph and pushes data with the expected shape', () => {
    renderView();
    expect(handle.graphData).toHaveBeenCalledWith({ nodes, links: edges });
    expect(handle.nodeId).toHaveBeenCalledWith('id');
    expect(handle.linkSource).toHaveBeenCalledWith('source');
    expect(handle.linkTarget).toHaveBeenCalledWith('target');
    expect(handle.nodeCanvasObjectMode).toHaveBeenCalledWith('after');
  });

  it('wires node click to focus, hidden-tag clicks to nothing, and background to clear', () => {
    const onNodeFocus = vi.fn();
    const onClearFocus = vi.fn();
    renderView({ onNodeFocus, onClearFocus, tagsVisible: false });

    const nodeClickCb = accessorFrom('onNodeClick') as (
      n: AugmentedGraphNode
    ) => void;
    nodeClickCb({ ...nodes[0] });
    expect(onNodeFocus).toHaveBeenCalledWith('a');

    nodeClickCb({ ...nodes[4] });
    expect(onNodeFocus).toHaveBeenCalledTimes(1);

    const bgClickCb = accessorFrom('onBackgroundClick') as () => void;
    bgClickCb();
    expect(onClearFocus).toHaveBeenCalled();
  });

  it('focuses visible tag nodes on click', () => {
    const onNodeFocus = vi.fn();
    renderView({ onNodeFocus, tagsVisible: true });

    const nodeClickCb = accessorFrom('onNodeClick') as (
      n: AugmentedGraphNode
    ) => void;
    nodeClickCb({ ...nodes[4] });
    expect(onNodeFocus).toHaveBeenCalledWith('tag:x');
  });

  it('applies dim-and-spotlight styling through the node color accessor', () => {
    renderView({ focusedNodeId: 'a' });

    const colorAccessor = accessorFrom('nodeColor') as (
      n: AugmentedGraphNode
    ) => string;
    expect(colorAccessor(nodes[0])).toBe('#2563eb');
    expect(colorAccessor(nodes[1])).toBe('#2563eb');
    expect(colorAccessor(nodes[2])).toBe('#d97706');
    expect(colorAccessor(nodes[3])).toBe('rgba(37, 99, 235, 0.15)');
    expect(colorAccessor(nodes[4])).toBe('rgba(22, 163, 74, 0.08)');
  });

  it('hides tag nodes through transparent styling when tags are hidden', () => {
    renderView({ tagsVisible: false });

    const colorAccessor = accessorFrom('nodeColor') as (
      n: AugmentedGraphNode
    ) => string;
    expect(colorAccessor(nodes[4])).toBe('rgba(0, 0, 0, 0)');

    const valAccessor = accessorFrom('nodeVal') as (
      n: AugmentedGraphNode
    ) => number;
    expect(valAccessor(nodes[4])).toBeCloseTo((nodes[4]._val ?? 1) * 0.05);

    const labelAccessor = accessorFrom('nodeLabel') as (
      n: AugmentedGraphNode
    ) => string;
    expect(labelAccessor(nodes[4])).toBe('');
  });

  it('renders placeholder labels as missing-page hints', () => {
    renderView();
    const labelAccessor = accessorFrom('nodeLabel') as (
      n: AugmentedGraphNode
    ) => string;
    expect(labelAccessor(nodes[2])).toBe('Missing page: missing');
    expect(labelAccessor(nodes[0])).toBe('A');
  });

  it('brightens touching edges and dims the rest while focused', () => {
    renderView({ focusedNodeId: 'a' });

    const widthAccessor = accessorFrom('linkWidth') as (
      l: AugmentedGraphEdge
    ) => number;
    expect(widthAccessor(edges[0])).toBe(3);
    expect(widthAccessor(edges[2])).toBe(0.05);
    expect(widthAccessor(edges[3])).toBe(0.5);

    const colorAccessor = accessorFrom('linkColor') as (
      l: AugmentedGraphEdge
    ) => string;
    expect(colorAccessor(edges[0])).toBe('rgba(37, 99, 235, 0.75)');
    expect(colorAccessor(edges[1])).toBe('rgba(217, 119, 6, 0.55)');
    expect(colorAccessor(edges[2])).toBe('rgba(148, 163, 184, 0.08)');
    expect(colorAccessor(edges[3])).toBe('rgba(34, 197, 94, 0.7)');

    const dashAccessor = accessorFrom('linkLineDash') as (
      l: AugmentedGraphEdge
    ) => number[] | null;
    expect(dashAccessor(edges[1])).toEqual([4, 3]);
    expect(dashAccessor(edges[0])).toBeNull();
  });

  it('styles broken links with amber and a dash when unfocused', () => {
    renderView();
    const colorAccessor = accessorFrom('linkColor') as (
      l: AugmentedGraphEdge
    ) => string;
    expect(colorAccessor(edges[1])).toBe('rgba(217, 119, 6, 0.55)');
    expect(colorAccessor(edges[0])).toBe('rgba(148, 163, 184, 0.4)');

    const widthAccessor = accessorFrom('linkWidth') as (
      l: AugmentedGraphEdge
    ) => number;
    expect(widthAccessor(edges[3])).toBe(0.5);
  });

  it('hides tag edges entirely when tags are hidden', () => {
    renderView({ tagsVisible: false });
    const colorAccessor = accessorFrom('linkColor') as (
      l: AugmentedGraphEdge
    ) => string;
    expect(colorAccessor(edges[3])).toBe('rgba(0, 0, 0, 0)');
    const widthAccessor = accessorFrom('linkWidth') as (
      l: AugmentedGraphEdge
    ) => number;
    expect(widthAccessor(edges[3])).toBe(0);
    const arrowAccessor = accessorFrom('linkDirectionalArrowColor') as (
      l: AugmentedGraphEdge
    ) => string;
    expect(arrowAccessor(edges[3])).toBe('rgba(0, 0, 0, 0)');
  });

  it('compensates node and link size on zoom', () => {
    renderView();
    const zoomCb = accessorFrom('onZoom') as (t: {
      k: number;
      x: number;
      y: number;
    }) => void;

    zoomCb({ k: 0.5, x: 0, y: 0 });
    expect(handle.nodeRelSize).toHaveBeenLastCalledWith(12);
    let widthAccessor = accessorFrom('linkWidth', 1) as (
      l: AugmentedGraphEdge
    ) => number;
    expect(widthAccessor(edges[0])).toBe(3);

    zoomCb({ k: 2, x: 0, y: 0 });
    expect(handle.nodeRelSize).toHaveBeenLastCalledWith(3);
    widthAccessor = accessorFrom('linkWidth', 2) as (
      l: AugmentedGraphEdge
    ) => number;
    expect(widthAccessor(edges[0])).toBe(0.75);
  });

  it('ignores non-finite zoom transforms instead of poisoning sizing', () => {
    renderView();
    const zoomCb = accessorFrom('onZoom') as (t: {
      k: number;
      x: number;
      y: number;
    }) => void;
    const relCalls = () =>
      (handle.nodeRelSize as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = relCalls();

    zoomCb({ k: NaN, x: 0, y: 0 });
    zoomCb({ k: Infinity, x: 0, y: 0 });
    expect(relCalls()).toBe(before);

    zoomCb({ k: 1, x: 0, y: 0 });
    expect(handle.nodeRelSize).toHaveBeenLastCalledWith(6);
  });

  it('auto-fits once per data change on engine stop', () => {
    renderView();
    const fitCalls = () =>
      (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls.length;
    const initial = fitCalls();

    const stopCb = accessorFrom('onEngineStop') as () => void;
    stopCb();
    expect(fitCalls()).toBe(initial + 1);

    stopCb();
    expect(fitCalls()).toBe(initial + 1);
  });

  it('skips camera fits until nodes have positions', () => {
    const unpositioned = nodes.map(n => ({ ...n, x: undefined, y: undefined }));
    const fitCalls = () =>
      (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls.length;
    const graphProps = {
      tagsVisible: true,
      onNodeFocus: vi.fn(),
      onClearFocus: vi.fn(),
      forceGraphFactory: () => handle as unknown as ForceGraphHandle,
    };

    const { rerender } = render(
      <WikiGraphView nodes={unpositioned} edges={edges} {...graphProps} />
    );
    // Mount runs the clear-focus fit; it must be skipped pre-layout.
    expect(fitCalls()).toBe(0);

    const stopCb = accessorFrom('onEngineStop') as () => void;
    stopCb();
    // The auto-fit stays pending (not consumed) when nothing is positioned.
    expect(fitCalls()).toBe(0);

    rerender(<WikiGraphView nodes={nodes} edges={edges} {...graphProps} />);
    stopCb();
    expect(fitCalls()).toBe(1);
  });

  it('moves the camera to the focused node and refits on clear', () => {
    const { rerender } = render(
      <WikiGraphView
        nodes={nodes}
        edges={edges}
        tagsVisible={true}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
      />
    );

    rerender(
      <WikiGraphView
        nodes={nodes}
        edges={edges}
        tagsVisible={true}
        focusedNodeId="a"
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
      />
    );
    expect(handle.centerAt).toHaveBeenCalledWith(10, 20, 600);
    expect(handle.zoom).toHaveBeenCalledWith(1.6, 600);

    rerender(
      <WikiGraphView
        nodes={nodes}
        edges={edges}
        tagsVisible={true}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
      />
    );
    expect(handle.zoomToFit).toHaveBeenCalledWith(600, 40);
  });

  it('applies the light-theme link color and re-applies dark on theme flip', async () => {
    renderView();
    let colorAccessor = accessorFrom('linkColor') as (
      l: AugmentedGraphEdge
    ) => string;
    expect(colorAccessor(edges[0])).toBe('rgba(148, 163, 184, 0.4)');

    document.documentElement.classList.add('dark');
    await waitFor(() => {
      colorAccessor = accessorFrom('linkColor', 1) as (
        l: AugmentedGraphEdge
      ) => string;
      expect(colorAccessor(edges[0])).toBe('rgba(200, 205, 220, 0.7)');
    });
    document.documentElement.classList.remove('dark');
  });

  it('sizes the canvas from the container measurements', () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 640,
          height: 360,
          top: 0,
          left: 0,
          right: 640,
          bottom: 360,
          x: 0,
          y: 0,
        }) as DOMRect
    );

    try {
      renderView();
      expect(handle.width).toHaveBeenCalledWith(640);
      expect(handle.height).toHaveBeenCalledWith(360);
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('renders the legend and zoom controls and wires them to the handle', async () => {
    const user = userEvent.setup();
    renderView();

    expect(screen.getByTestId('wiki-graph-legend').textContent).toContain(
      'Page'
    );
    expect(screen.getByTestId('wiki-graph-legend').textContent).toContain(
      'Tag'
    );
    expect(screen.getByTestId('wiki-graph-legend').textContent).toContain(
      'Broken link'
    );

    await user.click(screen.getByTestId('wiki-graph-zoom-in'));
    expect(handle.zoom).toHaveBeenLastCalledWith(1.3, 200);

    await user.click(screen.getByTestId('wiki-graph-zoom-out'));
    expect(handle.zoom).toHaveBeenLastCalledWith(1 / 1.3, 200);

    const resetCalls = (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await user.click(screen.getByTestId('wiki-graph-zoom-reset'));
    expect(
      (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(resetCalls + 1);
  });

  it('renders a container for the graph', () => {
    renderView();
    expect(screen.getByTestId('wiki-graph-container')).toBeDefined();
  });

  it('destructs the graph on unmount', () => {
    const { unmount } = renderView();
    unmount();
    expect(handle._destructor).toHaveBeenCalled();
  });

  it('feeds the engine cloned links, leaving canonical edges unmutated', () => {
    renderView();
    const pushed = (handle.graphData as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { links: Array<{ source: unknown; target: unknown }> };
    expect(pushed.links).not.toBe(edges);
    expect(pushed.links[0]).not.toBe(edges[0]);
    expect(pushed.links[0].source).toBe('a');
    expect(typeof pushed.links[0].source).toBe('string');
    expect(edges[0].source).toBe('a');
    expect(typeof edges[0].source).toBe('string');

    const linkForce = handle.d3Force('link') as {
      distance: ReturnType<typeof vi.fn>;
    };
    const chargeForce = handle.d3Force('charge') as {
      strength: ReturnType<typeof vi.fn>;
    };
    expect(linkForce.distance).toHaveBeenCalledWith(90);
    expect(chargeForce.strength).toHaveBeenCalledWith(-240);
  });
});
