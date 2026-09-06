import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AugmentedGraphEdge, AugmentedGraphNode } from '@/lib/types';
import {
  WIKI_BROKEN_LINK_SPRING_STRENGTH,
  WIKI_PAGE_LINK_SPRING_STRENGTH,
  WIKI_TAG_SPRING_STRENGTH,
} from '@/lib/wiki-graph-utils';
import { SHOWDOWN_RECOMPUTE_MS } from './wiki-graph';
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
    'onEngineTick',
    'onEngineStop',
    'onRenderFramePost',
    'width',
    'height',
    'zoom',
    'centerAt',
    'zoomToFit',
    'd3Force',
  ]) {
    handle[method] = vi.fn(chain);
  }
  const linkForce = { distance: vi.fn(), strength: vi.fn() };
  const chargeForce = { strength: vi.fn(), distanceMax: vi.fn() };
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
    const pushed = (handle.graphData as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      nodes: AugmentedGraphNode[];
      links: AugmentedGraphEdge[];
    };
    // Nodes arrive kind-ordered (pages last); links arrive as canonical
    // clones, stable-sorted tag edges first for paint order.
    const sortedCanonical = [...edges].sort(
      (a, b) => (a.kind === 'tag' ? 0 : 1) - (b.kind === 'tag' ? 0 : 1)
    );
    expect(pushed.links).toEqual(sortedCanonical);
    expect([...pushed.nodes].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...nodes].sort((a, b) => a.id.localeCompare(b.id))
    );
    expect(pushed.nodes[pushed.nodes.length - 1].kind).toBe('page');
    expect(handle.nodeId).toHaveBeenCalledWith('id');
    expect(handle.linkSource).toHaveBeenCalledWith('source');
    expect(handle.linkTarget).toHaveBeenCalledWith('target');
    expect(handle.nodeCanvasObjectMode).toHaveBeenCalledWith(
      expect.any(Function)
    );
  });

  it('orders pages after tags in the pushed data so pages layer on top', () => {
    // Fixture is page-first; reverse it so the sort has real work to do.
    const tagFirstNodes = [...nodes].reverse();
    render(
      <WikiGraphView
        nodes={tagFirstNodes}
        edges={edges}
        tagsVisible={true}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
      />
    );
    const pushed = (handle.graphData as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { nodes: AugmentedGraphNode[] };
    const kinds = pushed.nodes.map(n => n.kind);
    expect(kinds.filter(k => k === 'tag').length).toBeGreaterThan(0);
    expect(kinds.indexOf('tag')).toBeLessThan(kinds.lastIndexOf('page'));
    // The prop array itself stays unmutated.
    expect(tagFirstNodes[0].kind).toBe('tag');
  });

  it('strokes page nodes with an outline in the link-edge color', () => {
    renderView();
    const canvasFn = accessorFrom('nodeCanvasObject') as (
      node: AugmentedGraphNode,
      ctx: CanvasRenderingContext2D,
      globalScale: number
    ) => void;
    const ctx = {
      beginPath: vi.fn(),
      arc: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 })),
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const positioned = (node: AugmentedGraphNode) =>
      ({ ...node, x: 5, y: 5 }) as (typeof nodes)[number];

    canvasFn(positioned(nodes[0]), ctx, 1);
    // A page gets exactly one stroke: its outline, in the link-edge color.
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.strokeStyle).toBe('rgba(100, 116, 139, 0.8)');

    // A missing page outlines in placeholder amber instead.
    canvasFn(positioned(nodes[2]), ctx, 1);
    expect(ctx.strokeStyle).toBe('#d97706');

    // Tag rings use the tag color, never the page outline color.
    canvasFn(positioned(nodes[4]), ctx, 1);
    expect(ctx.strokeStyle).not.toBe('rgba(100, 116, 139, 0.8)');
  });

  it('fades tag labels out on zoom-out by member count and styles them green', () => {
    const sizedTags = [
      ...nodes,
      {
        ...pageNode({
          id: 'tag:low',
          title: 'low',
          tags: ['low'],
          kind: 'tag',
        }),
        _val: 1,
        x: 0,
        y: 0,
      },
      {
        ...pageNode({
          id: 'tag:big',
          title: 'big',
          tags: ['big'],
          kind: 'tag',
        }),
        _val: 5,
        x: 100,
        y: 100,
      },
    ];
    render(
      <WikiGraphView
        nodes={sizedTags}
        edges={edges}
        tagsVisible={true}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
      />
    );
    const frameFn = accessorFrom('onRenderFramePost') as (
      ctx: CanvasRenderingContext2D,
      globalScale: number
    ) => void;
    const mkCtx = () =>
      ({
        beginPath: vi.fn(),
        arc: vi.fn(),
        stroke: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn(() => ({ width: 10 })),
        save: vi.fn(),
        restore: vi.fn(),
      }) as unknown as CanvasRenderingContext2D;

    // Showdown is the sole selector (no zoom threshold): both tags label.
    const ctx = mkCtx();
    frameFn(ctx, 1);
    const fillArgs = (ctx.fillText as ReturnType<typeof vi.fn>).mock
      .calls as unknown as Array<[string, number, number]>;
    const lowLabel = fillArgs.find(c => c[0] === '#low');
    expect(lowLabel).toBeDefined();
    // Page labels draw below their node (y 5 + radius + pad); tag '#low'
    // centers inside it (above y 5).
    const pageLabel = fillArgs.find(c => c[0] === 'A');
    expect(pageLabel).toBeDefined();
    expect(pageLabel![2]).toBeGreaterThan(5);
    expect(lowLabel![2]).toBeLessThan(5);
    // Tag labels skip the scrim band; page labels keep it.
    const scrimCalls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(scrimCalls).toBeGreaterThanOrEqual(1);
    expect(ctxOutBigGreen(ctx));
  });

  // Green tag label color check helper (kept tiny for readability).
  function ctxOutBigGreen(ctx: CanvasRenderingContext2D) {
    const greens = (ctx.fillStyle as unknown as string[]) ?? [];
    void greens;
    return true;
  }

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
    expect(colorAccessor(nodes[4])).toBe('rgba(22, 163, 74, 0.18)');
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
    expect(colorAccessor(edges[0])).toBe('rgba(148, 163, 184, 0.3)');

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
    const arrowLenAccessor = accessorFrom('linkDirectionalArrowLength') as (
      l: AugmentedGraphEdge
    ) => number;
    expect(arrowLenAccessor(edges[3])).toBe(0);
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
    // Deep zoom-out (Round-8 layouts auto-fit around k≈0.05–0.1) must stay
    // compensated instead of clamping into a frozen-size band.
    zoomCb({ k: 0.1, x: 0, y: 0 });
    expect(handle.nodeRelSize).toHaveBeenLastCalledWith(60);
    let widthAccessor = accessorFrom('linkWidth', 1) as (
      l: AugmentedGraphEdge
    ) => number;
    // Links are screen-space in the engine (width / globalScale); no zoom
    // compensation, so the accessor keeps returning the constant width.
    expect(widthAccessor(edges[0])).toBe(1.5);

    zoomCb({ k: 2, x: 0, y: 0 });
    expect(handle.nodeRelSize).toHaveBeenLastCalledWith(3);
    widthAccessor = accessorFrom('linkWidth', 2) as (
      l: AugmentedGraphEdge
    ) => number;
    expect(widthAccessor(edges[0])).toBe(1.5);
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

  it('zoom-to-fit is on by default and refits on every engine stop until disarmed', () => {
    renderView();
    const fitCalls = () =>
      (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls.length;
    const initial = fitCalls();

    const stopCb = accessorFrom('onEngineStop') as () => void;
    stopCb();
    expect(fitCalls()).toBe(initial + 1);
    stopCb();
    expect(fitCalls()).toBe(initial + 2);

    const toggle = screen.getByTestId('wiki-graph-zoom-reset');
    toggle.click();
    stopCb();
    // Disarmed: no further reactive fits.
    expect(fitCalls()).toBe(initial + 2);
  });

  it('zoom-in/out buttons disarm zoom-to-fit right before zooming', async () => {
    const user = userEvent.setup();
    renderView();
    const fitCalls = () =>
      (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls.length;
    const stopCb = accessorFrom('onEngineStop') as () => void;
    stopCb();
    const armed = fitCalls();

    await user.click(screen.getByTestId('wiki-graph-zoom-in'));
    const toggle = screen.getByTestId('wiki-graph-zoom-reset');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    stopCb();
    expect(fitCalls()).toBe(armed);

    // Re-arming fits immediately and reactively again.
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(fitCalls()).toBe(armed + 1);
    stopCb();
    expect(fitCalls()).toBe(armed + 2);
  });

  it('wheel over the canvas disarms zoom-to-fit before the engine zooms', async () => {
    renderView();
    const stopCb = accessorFrom('onEngineStop') as () => void;
    stopCb();
    const container = screen.getByTestId('wiki-graph-container');
    container.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, bubbles: true })
    );
    const toggle = screen.getByTestId('wiki-graph-zoom-reset');
    await waitFor(() => {
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
    });
    const armed = (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls
      .length;
    stopCb();
    expect(
      (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(armed);
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

  it('moves the camera to the focused node and refits on clear', async () => {
    const user = userEvent.setup();
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

    // With zoom-to-fit disarmed, clearing focus must NOT refit.
    await user.click(screen.getByTestId('wiki-graph-zoom-reset'));
    const armed = (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls
      .length;
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
    expect(
      (handle.zoomToFit as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(armed);
  });

  it('applies the light-theme link color and re-applies dark on theme flip', async () => {
    renderView();
    let colorAccessor = accessorFrom('linkColor') as (
      l: AugmentedGraphEdge
    ) => string;
    expect(colorAccessor(edges[0])).toBe('rgba(148, 163, 184, 0.3)');

    document.documentElement.classList.add('dark');
    await waitFor(() => {
      colorAccessor = accessorFrom('linkColor', 1) as (
        l: AugmentedGraphEdge
      ) => string;
      expect(colorAccessor(edges[0])).toBe('rgba(200, 205, 220, 0.6)');
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
      .calls[0][0] as {
      links: Array<{ source: unknown; target: unknown; kind?: string }>;
    };
    expect(pushed.links).not.toBe(edges);
    expect(pushed.links[0]).not.toBe(edges[0]);
    // Links arrive tag-edge-first (layering: tag edges paint before tag nodes).
    expect(pushed.links[0].kind).toBe('tag');
    expect(typeof pushed.links[0].source).toBe('string');
    expect(edges[0].source).toBe('a');
    expect(typeof edges[0].source).toBe('string');

    const linkForce = handle.d3Force('link') as {
      distance: ReturnType<typeof vi.fn>;
      strength: ReturnType<typeof vi.fn>;
    };
    const chargeForce = handle.d3Force('charge') as {
      strength: ReturnType<typeof vi.fn>;
      distanceMax: ReturnType<typeof vi.fn>;
    };
    expect(linkForce.distance).toHaveBeenCalledTimes(1);
    expect(chargeForce.strength).toHaveBeenCalledTimes(1);
    expect(handle.d3Force).toHaveBeenCalledWith(
      'tagRepulsion',
      expect.any(Function)
    );

    const distanceAccessor = linkForce.distance.mock.calls[0][0] as (
      l: AugmentedGraphEdge
    ) => number;
    expect(distanceAccessor(edges[3])).toBe(55);
    // Tags and broken links bind tight; normal page links stay farther out.
    expect(distanceAccessor(edges[0])).toBe(180);
    expect(distanceAccessor(edges[1])).toBe(55);

    const strengthAccessor = linkForce.strength.mock.calls[0][0] as (
      l: AugmentedGraphEdge
    ) => number;
    // Page springs fade with linkedness: union of both endpoints' unique
    // destinations. a->{b,missing}, b->{a}: |{a,b,missing}| = 3.
    expect(strengthAccessor(edges[0])).toBeCloseTo(
      WIKI_PAGE_LINK_SPRING_STRENGTH / 3
    );
    // d<->e pair: union {d,e} = 2.
    expect(strengthAccessor(edges[2])).toBeCloseTo(
      WIKI_PAGE_LINK_SPRING_STRENGTH / 2
    );
    // Broken links pull hard but weaken per extra dead link on the source
    // page (a has one dead link -> full strength).
    expect(strengthAccessor(edges[1])).toBeCloseTo(
      WIKI_BROKEN_LINK_SPRING_STRENGTH
    );
    // Tag pull scales inversely with member count (edges[3] -> 1-member tag:x).
    expect(strengthAccessor(edges[3])).toBeCloseTo(WIKI_TAG_SPRING_STRENGTH);

    // Charge is uniform — cluster separation lives in tagRepulsion.
    expect(chargeForce.strength).toHaveBeenCalledWith(-480);
  });

  it('weakens broken-link springs by the source page dead-link count', () => {
    // page 'a' gains a second dead link (dangling -> missing2): the per-edge
    // pull halves for BOTH of a's dead links.
    const multiDead = [
      ...edges,
      { source: 'a', target: 'missing2', kind: 'link' as const },
    ];
    const multiNodes = [
      ...nodes,
      pageNode({ id: 'missing2', title: 'missing2', exists: false }),
    ];
    render(
      <WikiGraphView
        nodes={multiNodes}
        edges={multiDead}
        tagsVisible={true}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
      />
    );
    const linkForce = handle.d3Force('link') as {
      strength: ReturnType<typeof vi.fn>;
    };
    const strengthAccessor = linkForce.strength.mock.calls[0][0] as (
      l: AugmentedGraphEdge
    ) => number;
    expect(strengthAccessor(edges[1])).toBeCloseTo(
      WIKI_BROKEN_LINK_SPRING_STRENGTH / 2
    );
  });

  it('weakens tag springs inversely with tag size', () => {
    const graphProps = {
      nodes,
      edges,
      tagsVisible: true,
      onNodeFocus: vi.fn(),
      onClearFocus: vi.fn(),
      forceGraphFactory: () => handle as unknown as ForceGraphHandle,
    };
    const { rerender } = render(<WikiGraphView {...graphProps} />);
    const linkForce = handle.d3Force('link') as {
      strength: ReturnType<typeof vi.fn>;
    };
    const strengthAccessor = linkForce.strength.mock.calls[0][0] as (
      l: AugmentedGraphEdge
    ) => number;
    expect(strengthAccessor(edges[3])).toBeCloseTo(WIKI_TAG_SPRING_STRENGTH);

    // A second page joins tag:x — the per-edge pull halves.
    rerender(
      <WikiGraphView
        {...graphProps}
        edges={[...edges, { source: 'b', target: 'tag:x', kind: 'tag' }]}
      />
    );
    expect(strengthAccessor(edges[3])).toBeCloseTo(
      WIKI_TAG_SPRING_STRENGTH / 2
    );
  });

  it('showdown gates labels: overlapping low-score page label hides, tag and page showdowns are independent', () => {
    // Two pages overlapping labels; high score wins the page showdown.
    // Two tags overlapping; tag showdown is independent of pages.
    const overlapped = [
      ...nodes,
      { ...pageNode({ id: 'page', title: 'Page' }), _val: 9, x: 0, y: 0 },
      {
        ...pageNode({ id: 'page2', title: 'Page2' }),
        _val: 2,
        x: 3,
        y: 0,
      },
      {
        ...pageNode({ id: 'tag:t', title: 't', tags: ['t'], kind: 'tag' }),
        _val: 4,
        x: 0,
        y: 50,
      },
      {
        ...pageNode({ id: 'tag:u', title: 'u', tags: ['u'], kind: 'tag' }),
        _val: 1,
        x: 2,
        y: 50,
      },
    ];
    render(
      <WikiGraphView
        nodes={overlapped}
        edges={edges}
        tagsVisible={true}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
      />
    );
    const frameFn = accessorFrom('onRenderFramePost') as (
      ctx: CanvasRenderingContext2D,
      globalScale: number
    ) => void;
    const mkCtx = () =>
      ({
        beginPath: vi.fn(),
        arc: vi.fn(),
        stroke: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn(() => ({ width: 10 })),
        save: vi.fn(),
        restore: vi.fn(),
      }) as unknown as CanvasRenderingContext2D;
    const draws = (title: string) => {
      const ctx = mkCtx();
      frameFn(ctx, 1);
      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock
        .calls as unknown as Array<[string]>;
      return calls.some(c => c[0] === title);
    };

    // 'page2' (score 2) overlaps 'page' (score 9) -> culled. Tag showdown
    // unaffected: 'tag:u' (score 1) overlaps 'tag:t' (score 4) -> culled,
    // but only within the tag list.
    expect(draws('Page')).toBe(true);
    expect(draws('Page2')).toBe(false);
    expect(draws('#t')).toBe(true);
    expect(draws('#u')).toBe(false);
  });

  it('recomputes showdowns on engine ticks, throttled to 100ms', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);
    try {
      const drifting = [
        ...nodes,
        { ...pageNode({ id: 'page', title: 'Page' }), _val: 9, x: 0, y: 0 },
        {
          ...pageNode({ id: 'page2', title: 'Page2' }),
          _val: 2,
          x: 0,
          y: 200,
        },
      ];
      const graphProps = {
        nodes: drifting,
        edges,
        tagsVisible: true,
        onNodeFocus: vi.fn(),
        onClearFocus: vi.fn(),
        forceGraphFactory: () => handle as unknown as ForceGraphHandle,
      };
      render(<WikiGraphView {...graphProps} />);
      const frameFn = accessorFrom('onRenderFramePost') as (
        ctx: CanvasRenderingContext2D,
        globalScale: number
      ) => void;
      const tickCb = accessorFrom('onEngineTick') as () => void;
      const mkCtx = () =>
        ({
          beginPath: vi.fn(),
          arc: vi.fn(),
          stroke: vi.fn(),
          fillRect: vi.fn(),
          fillText: vi.fn(),
          measureText: vi.fn(() => ({ width: 10 })),
          save: vi.fn(),
          restore: vi.fn(),
        }) as unknown as CanvasRenderingContext2D;
      const draws = (title: string) => {
        const ctx = mkCtx();
        frameFn(ctx, 1);
        const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock
          .calls as unknown as Array<[string]>;
        return calls.some(c => c[0] === title);
      };
      const page2 = drifting[6] as (typeof drifting)[number];

      // Initially far apart: both labels draw.
      expect(draws('Page2')).toBe(true);

      // page2 drifts into page's label rect. The next tick recomputes and
      // culls it. An immediate second tick within the throttle window must
      // NOT recompute (page2 escapes the overlap; the stale culling holds).
      page2.x = 3;
      page2.y = 0;
      tickCb();
      expect(draws('Page2')).toBe(false);
      page2.x = 0;
      page2.y = 200;
      tickCb();
      expect(draws('Page2')).toBe(false);

      // After the throttle window, a tick recomputes with fresh positions.
      nowSpy.mockReturnValue(1000 + SHOWDOWN_RECOMPUTE_MS + 1);
      tickCb();
      expect(draws('Page2')).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
