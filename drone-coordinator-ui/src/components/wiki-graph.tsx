import { useEffect, useRef } from 'react';
import ForceGraph from 'force-graph';
import {
  buildFocusSets,
  d3DefaultLinkStrength,
  edgeKey,
  edgeEndpointId,
  labelDegreeThreshold,
  wikiLinkDegrees,
  WIKI_CHARGE_DISTANCE_MAX,
  WIKI_LINK_DISTANCE,
  WIKI_CHARGE_STRENGTH,
  WIKI_TAG_LINK_DISTANCE,
  WIKI_TAG_SPRING_STRENGTH,
  WIKI_TAG_CHARGE_STRENGTH,
} from '@/lib/wiki-graph-utils';
import type { AugmentedGraphEdge, AugmentedGraphNode } from '@/lib/types';

/**
 * Minimal structural type for the parts of the force-graph API we use, so the
 * real library can be swapped without touching consumers. The imperative
 * handle returned by the factory exposes chainable setters and callbacks.
 */
export interface ForceGraphHandle {
  graphData(data: {
    nodes: AugmentedGraphNode[];
    links: AugmentedGraphEdge[];
  }): ForceGraphHandle;
  nodeId(key: string): ForceGraphHandle;
  linkSource(key: string): ForceGraphHandle;
  linkTarget(key: string): ForceGraphHandle;
  nodeRelSize(size: number): ForceGraphHandle;
  nodeVal(accessor: (node: AugmentedGraphNode) => number): ForceGraphHandle;
  nodeColor(accessor: (node: AugmentedGraphNode) => string): ForceGraphHandle;
  nodeCanvasObject(
    renderFn: (
      node: AugmentedGraphNode,
      ctx: CanvasRenderingContext2D,
      globalScale: number
    ) => void
  ): ForceGraphHandle;
  nodeCanvasObjectMode(mode: string): ForceGraphHandle;
  nodeLabel(accessor: (node: AugmentedGraphNode) => string): ForceGraphHandle;
  linkDirectionalArrowLength(length: number): ForceGraphHandle;
  linkDirectionalArrowColor(
    accessor: (link: AugmentedGraphEdge) => string
  ): ForceGraphHandle;
  linkWidth(accessor: (link: AugmentedGraphEdge) => number): ForceGraphHandle;
  linkColor(accessor: (link: AugmentedGraphEdge) => string): ForceGraphHandle;
  linkLineDash(
    accessor: (link: AugmentedGraphEdge) => number[] | null
  ): ForceGraphHandle;
  onNodeClick(cb: (node: AugmentedGraphNode) => void): ForceGraphHandle;
  onBackgroundClick(cb: () => void): ForceGraphHandle;
  onZoom(
    cb: (transform: { k: number; x: number; y: number }) => void
  ): ForceGraphHandle;
  onEngineStop(cb: () => void): ForceGraphHandle;
  d3Force(forceName: string): unknown;
  d3Force(forceName: string, forceFn: unknown): ForceGraphHandle;
  width(px: number): ForceGraphHandle;
  height(px: number): ForceGraphHandle;
  zoom(scale: number, durationMs?: number): ForceGraphHandle;
  centerAt(x?: number, y?: number, durationMs?: number): ForceGraphHandle;
  zoomToFit(durationMs?: number, padding?: number): ForceGraphHandle;
}

/** d3 link force subset used for layout tuning (getter via d3Force). */
type D3LinkForce = {
  distance(accessor: (link: AugmentedGraphEdge) => number): D3LinkForce;
  strength(accessor: (link: AugmentedGraphEdge) => number): D3LinkForce;
};
/** d3 many-body force subset used for layout tuning (getter via d3Force). */
type D3ChargeForce = {
  strength(accessor: (node: AugmentedGraphNode) => number): D3ChargeForce;
  distanceMax(max: number): D3ChargeForce;
};

type PositionedNode = AugmentedGraphNode & { x?: number; y?: number };

function defaultFactory(el: HTMLElement): ForceGraphHandle {
  // force-graph's default export is a class with the imperative API above.
  // The instance type is structurally compatible with ForceGraphHandle.
  return new (
    ForceGraph as unknown as new (el: HTMLElement) => ForceGraphHandle
  )(el);
}

const PAGE_BLUE = '#2563eb';
const PAGE_DIM = 'rgba(37, 99, 235, 0.15)';
const FOCUS_RING = '#60a5fa';
const TAG_FILL_LIGHT = 'rgba(22, 163, 74, 0.08)';
const TAG_FILL_DARK = 'rgba(34, 197, 94, 0.08)';
const TAG_RING_LIGHT = '#16a34a';
const TAG_RING_DARK = '#22c55e';
const TAG_DIM = 'rgba(34, 197, 94, 0.08)';
const TAG_EDGE = 'rgba(34, 197, 94, 0.25)';
const TAG_EDGE_LIT = 'rgba(34, 197, 94, 0.7)';
const PLACEHOLDER_AMBER = '#d97706';
const PLACEHOLDER_DIM = 'rgba(217, 119, 6, 0.15)';
const BROKEN_LINK_LIGHT = 'rgba(217, 119, 6, 0.55)';
const BROKEN_LINK_DARK = 'rgba(217, 119, 6, 0.75)';
const LINK_COLOR_LIGHT = 'rgba(148, 163, 184, 0.4)';
const LINK_COLOR_DARK = 'rgba(200, 205, 220, 0.7)';
const LINK_LIT_LIGHT = 'rgba(37, 99, 235, 0.75)';
const LINK_LIT_DARK = 'rgba(147, 197, 253, 0.9)';
const LINK_DIM_LIGHT = 'rgba(148, 163, 184, 0.08)';
const LINK_DIM_DARK = 'rgba(200, 205, 220, 0.1)';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const BASE_NODE_REL_SIZE = 6;
const MIN_NODE_REL_SIZE = 0.35;
const MAX_NODE_REL_SIZE = 20;
/** Screen-space link width; the engine already divides by zoom internally. */
const BASE_LINK_WIDTH = 1.5;
const MIN_ZOOM_K = 0.05;
const MAX_ZOOM_K = 10;
const ZOOM_STEP = 1.3;
const FIT_MS = 600;
const FIT_PADDING = 40;

/**
 * Engine-mutation isolation: force-graph's link parsing replaces string
 * endpoints with node references ON THE OBJECTS PASSED TO graphData (and
 * d3-force mutates them further). Feeding it shallow clones keeps the
 * canonical edges passed as props string-based, which the page's tag-member
 * counting and focus logic rely on.
 */
function toEngineLinks(edges: AugmentedGraphEdge[]): AugmentedGraphEdge[] {
  return edges.map(edge => ({ ...edge }));
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

const isFiniteNumber = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export default function WikiGraphView({
  nodes,
  edges,
  focusedNodeId,
  tagsVisible,
  onNodeFocus,
  onClearFocus,
  forceGraphFactory = defaultFactory,
}: {
  nodes: AugmentedGraphNode[];
  edges: AugmentedGraphEdge[];
  focusedNodeId?: string | null;
  tagsVisible: boolean;
  onNodeFocus: (pageId: string) => void;
  onClearFocus: () => void;
  forceGraphFactory?: (el: HTMLElement) => ForceGraphHandle;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ForceGraphHandle | null>(null);

  // Accessors are closures the engine calls per frame; reactive values reach
  // them through these refs rather than React state.
  const cbRef = useRef({ onNodeFocus, onClearFocus });
  cbRef.current = { onNodeFocus, onClearFocus };

  const zoomRef = useRef({ k: 1, x: 0, y: 0 });
  const nodeRelSizeRef = useRef(BASE_NODE_REL_SIZE);
  const baseLinkWidthRef = useRef(BASE_LINK_WIDTH);
  const tagsVisibleRef = useRef(tagsVisible);
  tagsVisibleRef.current = tagsVisible;

  const focusedIdRef = useRef<string | null>(focusedNodeId ?? null);
  const focusSetsRef = useRef<ReturnType<typeof buildFocusSets> | null>(null);
  const nodesRef = useRef<PositionedNode[]>([]);
  const nodesByIdRef = useRef(new Map<string, AugmentedGraphNode>());
  const linkDegreesRef = useRef(new Map<string, number>());
  const autoFitPendingRef = useRef(true);
  const prevNodeCountRef = useRef<number | null>(null);
  /** Max wiki-link degree in the current data; scales label thresholds. */
  const maxLinkDegreeRef = useRef(0);
  /** Degree over every layout edge (link + tag); scales d3 default springs. */
  const layoutEdgeDegreesRef = useRef(new Map<string, number>());

  // Set by the mount effect so later effects can restyle without re-running
  // the graph setup. Accessors live inside the mount effect: they close over
  // refs only, so they never need reactive dependencies.
  const zoomStylesRef = useRef<(fg: ForceGraphHandle, k: number) => void>(
    () => {}
  );
  const repaintRef = useRef<(fg: ForceGraphHandle) => void>(() => {});

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fg = forceGraphFactory(el);
    handleRef.current = fg;

    const applyThemeColors = () => {
      const dark = isDarkMode();
      theme.linkColor = dark ? LINK_COLOR_DARK : LINK_COLOR_LIGHT;
      theme.brokenLink = dark ? BROKEN_LINK_DARK : BROKEN_LINK_LIGHT;
      theme.litLink = dark ? LINK_LIT_DARK : LINK_LIT_LIGHT;
      theme.dimLink = dark ? LINK_DIM_DARK : LINK_DIM_LIGHT;
      theme.tagFill = dark ? TAG_FILL_DARK : TAG_FILL_LIGHT;
      theme.tagRing = dark ? TAG_RING_DARK : TAG_RING_LIGHT;
    };
    const theme = {
      linkColor: LINK_COLOR_LIGHT,
      brokenLink: BROKEN_LINK_LIGHT,
      litLink: LINK_LIT_LIGHT,
      dimLink: LINK_DIM_LIGHT,
      tagFill: TAG_FILL_LIGHT,
      tagRing: TAG_RING_LIGHT,
    };
    applyThemeColors();

    const isBrokenLink = (link: AugmentedGraphEdge) =>
      link.kind === 'link' &&
      nodesByIdRef.current.get(edgeEndpointId(link.target))?.exists === false;

    const nodeColorAccessor = (node: AugmentedGraphNode): string => {
      const focus = focusSetsRef.current;
      const dimmed = focus !== null && !focus.neighborIds.has(node.id);
      if (node.kind === 'tag') {
        if (!tagsVisibleRef.current) return TRANSPARENT;
        return dimmed ? TAG_DIM : theme.tagFill;
      }
      if (!node.exists) return dimmed ? PLACEHOLDER_DIM : PLACEHOLDER_AMBER;
      return dimmed ? PAGE_DIM : PAGE_BLUE;
    };

    const linkWidthAccessor = (link: AugmentedGraphEdge): number => {
      if (link.kind === 'tag') return tagsVisibleRef.current ? 0.5 : 0;
      const focus = focusSetsRef.current;
      if (!focus) return baseLinkWidthRef.current;
      if (focus.touchingEdgeKeys.has(edgeKey(link)))
        return baseLinkWidthRef.current * 2;
      return 0.05;
    };

    const linkColorAccessor = (link: AugmentedGraphEdge): string => {
      if (link.kind === 'tag') {
        if (!tagsVisibleRef.current) return TRANSPARENT;
        const focus = focusSetsRef.current;
        if (focus && focus.touchingEdgeKeys.has(edgeKey(link)))
          return TAG_EDGE_LIT;
        return TAG_EDGE;
      }
      const focus = focusSetsRef.current;
      if (focus) {
        return focus.touchingEdgeKeys.has(edgeKey(link))
          ? isBrokenLink(link)
            ? theme.brokenLink
            : theme.litLink
          : theme.dimLink;
      }
      return isBrokenLink(link) ? theme.brokenLink : theme.linkColor;
    };

    const linkDashAccessor = (link: AugmentedGraphEdge): number[] | null =>
      isBrokenLink(link) ? [4, 3] : null;

    const arrowColorAccessor = (link: AugmentedGraphEdge): string =>
      link.kind === 'tag' && !tagsVisibleRef.current
        ? TRANSPARENT
        : linkColorAccessor(link);

    const nodeValAccessor = (node: AugmentedGraphNode): number => {
      const base = node._val ?? 1;
      if (node.kind === 'tag' && !tagsVisibleRef.current) return base * 0.05;
      return base;
    };

    const nodeLabelAccessor = (node: AugmentedGraphNode): string => {
      if (node.kind === 'tag') {
        return tagsVisibleRef.current ? `#${node.title}` : '';
      }
      return node.exists ? node.title : `Missing page: ${node.id}`;
    };

    const nodeCanvasObjectAccessor = (
      node: AugmentedGraphNode,
      ctx: CanvasRenderingContext2D,
      globalScale: number
    ) => {
      const positioned = node as PositionedNode;
      if (positioned.x === undefined || positioned.y === undefined) return;
      const focus = focusSetsRef.current;
      const dimmed = focus !== null && !focus.neighborIds.has(node.id);
      const radius = Math.sqrt(node._val ?? 1) * nodeRelSizeRef.current * 0.5;

      if (node.kind === 'tag' && tagsVisibleRef.current) {
        // Hollow ring: the engine paints a near-transparent fill; we stroke it.
        ctx.beginPath();
        ctx.arc(positioned.x, positioned.y, radius, 0, 2 * Math.PI);
        ctx.strokeStyle = dimmed ? TAG_DIM : theme.tagRing;
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      if (focusedIdRef.current === node.id) {
        ctx.beginPath();
        ctx.arc(
          positioned.x,
          positioned.y,
          radius + 4 / globalScale,
          0,
          2 * Math.PI
        );
        ctx.strokeStyle = node.kind === 'tag' ? theme.tagRing : FOCUS_RING;
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      }

      if (dimmed) return;
      if (node.kind === 'tag' && !tagsVisibleRef.current) return;
      const degree = linkDegreesRef.current.get(node.id) ?? 0;
      if (
        node.kind === 'page' &&
        degree <
          labelDegreeThreshold(zoomRef.current.k, maxLinkDegreeRef.current)
      )
        return;

      const fontSize = Math.max(11 / globalScale, 4);
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = node.kind === 'tag' ? `#${node.title}` : node.title;
      const textWidth = ctx.measureText(label).width;
      const textY = positioned.y + radius + 3 / globalScale;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.fillRect(
        positioned.x - textWidth / 2 - 2 / globalScale,
        textY - 1 / globalScale,
        textWidth + 4 / globalScale,
        fontSize + 3 / globalScale
      );
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fillText(label, positioned.x, textY);
    };

    const applyZoomStyles = (handle: ForceGraphHandle, k: number) => {
      if (!isFiniteNumber(k) || k <= 0) return;
      nodeRelSizeRef.current = clamp(
        BASE_NODE_REL_SIZE / k,
        MIN_NODE_REL_SIZE,
        MAX_NODE_REL_SIZE
      );
      handle.nodeRelSize(nodeRelSizeRef.current);
      handle.linkWidth(linkWidthAccessor);
    };
    zoomStylesRef.current = applyZoomStyles;

    // Per-kind layout forces: page links get d3's stock spring (reproduced
    // as an accessor so the tag branch can stiffen without NaN), while tag
    // edges are short stiff springs binding member pages into topical
    // clusters and tag nodes carry extra charge to push clusters apart.
    // Accessors must return finite numbers for every edge/node — d3
    // unary-pluses them into the force arrays.
    const linkForce = fg.d3Force('link') as D3LinkForce | undefined;
    if (linkForce) {
      linkForce.distance(link =>
        link.kind === 'tag' ? WIKI_TAG_LINK_DISTANCE : WIKI_LINK_DISTANCE
      );
      linkForce.strength(link =>
        link.kind === 'tag'
          ? WIKI_TAG_SPRING_STRENGTH
          : d3DefaultLinkStrength(link, layoutEdgeDegreesRef.current)
      );
    }
    const chargeForce = fg.d3Force('charge') as D3ChargeForce | undefined;
    if (chargeForce) {
      chargeForce.strength(node =>
        node.kind === 'tag' ? WIKI_TAG_CHARGE_STRENGTH : WIKI_CHARGE_STRENGTH
      );
      chargeForce.distanceMax(WIKI_CHARGE_DISTANCE_MAX);
    }

    const repaint = () => {
      // The render loop repaints continuously; re-setting an accessor-bearing
      // prop simply guarantees the next frame exists even when idle.
      fg.nodeRelSize(nodeRelSizeRef.current);
    };
    repaintRef.current = repaint;

    const applySize = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) fg.width(rect.width).height(rect.height);
    };
    applySize();
    applyZoomStyles(fg, zoomRef.current.k);

    const { onNodeFocus: focus, onClearFocus: clear } = cbRef.current;
    fg.nodeId('id')
      .linkSource('source')
      .linkTarget('target')
      .nodeVal(nodeValAccessor)
      .nodeColor(nodeColorAccessor)
      .nodeCanvasObject(nodeCanvasObjectAccessor)
      .nodeCanvasObjectMode('after')
      .nodeLabel(nodeLabelAccessor)
      .linkWidth(linkWidthAccessor)
      .linkColor(linkColorAccessor)
      .linkLineDash(linkDashAccessor)
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowColor(arrowColorAccessor)
      .onNodeClick(node => {
        if (node.kind === 'tag' && !tagsVisibleRef.current) return;
        focus(String(node.id));
      })
      .onBackgroundClick(() => clear())
      .onZoom(transform => {
        if (
          !isFiniteNumber(transform.k) ||
          !isFiniteNumber(transform.x) ||
          !isFiniteNumber(transform.y)
        )
          return;
        zoomRef.current = transform;
        applyZoomStyles(fg, transform.k);
      })
      .onEngineStop(() => {
        if (autoFitPendingRef.current) {
          if (
            nodesRef.current.some(
              n => isFiniteNumber(n.x) && isFiniteNumber(n.y)
            )
          ) {
            autoFitPendingRef.current = false;
            fg.zoomToFit(FIT_MS, FIT_PADDING);
          }
        }
      });

    // Re-apply theme colors when the root theme class flips (dark ⇄ light).
    // force-graph renders to a canvas, so CSS alone can't recolor the scene.
    const observer = new MutationObserver(() => {
      applyThemeColors();
      fg.linkColor(linkColorAccessor);
      repaint();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: false,
    });

    window.addEventListener('resize', applySize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', applySize);
      (fg as unknown as { _destructor?: () => void })._destructor?.();
      handleRef.current = null;
      repaintRef.current = () => {};
      zoomStylesRef.current = () => {};
    };
  }, [forceGraphFactory]);

  // Push data (and the derived ref state accessors read) into the graph.
  useEffect(() => {
    const fg = handleRef.current;
    if (!fg) return;
    nodesRef.current = nodes;
    nodesByIdRef.current = new Map(nodes.map(n => [n.id, n]));
    linkDegreesRef.current = wikiLinkDegrees(edges);
    maxLinkDegreeRef.current = Math.max(0, ...linkDegreesRef.current.values());
    layoutEdgeDegreesRef.current = new Map();
    for (const edge of edges) {
      const sourceId = edgeEndpointId(edge.source);
      const targetId = edgeEndpointId(edge.target);
      layoutEdgeDegreesRef.current.set(
        sourceId,
        (layoutEdgeDegreesRef.current.get(sourceId) ?? 0) + 1
      );
      layoutEdgeDegreesRef.current.set(
        targetId,
        (layoutEdgeDegreesRef.current.get(targetId) ?? 0) + 1
      );
    }
    fg.graphData({ nodes, links: toEngineLinks(edges) });
    zoomStylesRef.current(fg, zoomRef.current.k);
    if (prevNodeCountRef.current !== nodes.length) {
      autoFitPendingRef.current = true;
      prevNodeCountRef.current = nodes.length;
    }
  }, [nodes, edges]);

  // Focus changes restyle via refs and move the camera; the data itself is
  // untouched so the layout does not reheat.
  useEffect(() => {
    const fg = handleRef.current;
    if (!fg) return;
    focusedIdRef.current = focusedNodeId ?? null;
    focusSetsRef.current = focusedNodeId
      ? buildFocusSets(edges, focusedNodeId)
      : null;
    repaintRef.current(fg);

    if (focusedNodeId) {
      const target = nodesRef.current.find(n => n.id === focusedNodeId);
      if (target && isFiniteNumber(target.x) && isFiniteNumber(target.y)) {
        fg.centerAt(target.x, target.y, FIT_MS);
        if (isFiniteNumber(zoomRef.current.k)) {
          fg.zoom(Math.max(zoomRef.current.k, 1.6), FIT_MS);
        }
      }
    } else {
      // Before the simulation positions nodes, the bbox is NaN and a fit
      // would poison the camera transform; skip until positions exist.
      const positioned = nodesRef.current.some(
        n => isFiniteNumber(n.x) && isFiniteNumber(n.y)
      );
      if (positioned) {
        fg.zoomToFit(FIT_MS, FIT_PADDING);
      }
    }
  }, [focusedNodeId, edges]);

  // Tag visibility is ref-only state; repaint so accessors pick it up.
  useEffect(() => {
    const fg = handleRef.current;
    if (!fg) return;
    repaintRef.current(fg);
  }, [tagsVisible]);

  return (
    <div
      data-testid="wiki-graph-container"
      className="relative w-full h-[calc(100vh-220px)] min-h-[480px]"
    >
      {/* force-graph wipes whatever element it mounts into
          (domNode.innerHTML = '' in its init), so the canvas gets a dedicated
          child and the chrome below stays React-owned. */}
      <div ref={containerRef} className="absolute inset-0" />
      <div
        data-testid="wiki-graph-legend"
        className="absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-3 rounded-md border bg-background/80 px-3 py-2 text-xs text-muted-foreground backdrop-blur"
      >
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: PAGE_BLUE }}
          />
          Page
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full border-2"
            style={{ borderColor: TAG_RING_LIGHT }}
          />
          Tag
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: PLACEHOLDER_AMBER }}
          />
          Broken link
        </span>
      </div>
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button
          type="button"
          data-testid="wiki-graph-zoom-in"
          aria-label="Zoom in"
          className="flex h-8 w-8 items-center justify-center rounded-md border bg-background/80 text-sm backdrop-blur hover:bg-accent"
          onClick={() =>
            handleRef.current?.zoom(
              clamp(zoomRef.current.k * ZOOM_STEP, MIN_ZOOM_K, MAX_ZOOM_K),
              200
            )
          }
        >
          +
        </button>
        <button
          type="button"
          data-testid="wiki-graph-zoom-out"
          aria-label="Zoom out"
          className="flex h-8 w-8 items-center justify-center rounded-md border bg-background/80 text-sm backdrop-blur hover:bg-accent"
          onClick={() =>
            handleRef.current?.zoom(
              clamp(zoomRef.current.k / ZOOM_STEP, MIN_ZOOM_K, MAX_ZOOM_K),
              200
            )
          }
        >
          −
        </button>
        <button
          type="button"
          data-testid="wiki-graph-zoom-reset"
          aria-label="Reset view"
          className="flex h-8 w-8 items-center justify-center rounded-md border bg-background/80 text-xs backdrop-blur hover:bg-accent"
          onClick={() => handleRef.current?.zoomToFit(FIT_MS, FIT_PADDING)}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
