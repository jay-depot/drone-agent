import { useEffect, useRef, useState } from 'react';
import ForceGraph from 'force-graph';
import {
  buildFocusSets,
  createTagRepulsionForce,
  edgeKey,
  brokenLinkSpringStrength,
  edgeEndpointId,
  pageLinkSpringStrength,
  tagSpringStrength,
  WIKI_CHARGE_STRENGTH,
  WIKI_PAGE_LINK_DISTANCE,
  WIKI_TAG_LINK_DISTANCE,
  WIKI_TAG_REPULSION_STRENGTH,
} from '@/lib/wiki-graph-utils';
import {
  selectShowdownSurvivors,
  type ShowdownCandidate,
} from '@/lib/label-showdown';
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
  nodeCanvasObjectMode(
    mode: string | ((node: AugmentedGraphNode) => string)
  ): ForceGraphHandle;
  nodeLabel(accessor: (node: AugmentedGraphNode) => string): ForceGraphHandle;
  linkDirectionalArrowLength(
    length: number | ((link: AugmentedGraphEdge) => number)
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
  onEngineTick(cb: () => void): ForceGraphHandle;
  onEngineStop(cb: () => void): ForceGraphHandle;
  onRenderFramePost(
    cb: (ctx: CanvasRenderingContext2D, globalScale: number) => void
  ): ForceGraphHandle;
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
  strength(
    strength: number | ((node: AugmentedGraphNode) => number)
  ): D3ChargeForce;
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
const TAG_FILL_LIGHT = 'rgba(22, 163, 74, 0.18)';
const TAG_FILL_DARK = 'rgba(34, 197, 94, 0.18)';
const TAG_RING_LIGHT = '#16a34a';
const TAG_RING_DARK = '#22c55e';
const TAG_DIM = 'rgba(34, 197, 94, 0.08)';
const TAG_EDGE = 'rgba(34, 197, 94, 0.25)';
const TAG_EDGE_LIT = 'rgba(34, 197, 94, 0.7)';
const PLACEHOLDER_AMBER = '#d97706';
const PLACEHOLDER_DIM = 'rgba(217, 119, 6, 0.15)';
const BROKEN_LINK_LIGHT = 'rgba(217, 119, 6, 0.55)';
const BROKEN_LINK_DARK = 'rgba(217, 119, 6, 0.75)';
const LINK_COLOR_LIGHT = 'rgba(148, 163, 184, 0.3)';
const LINK_COLOR_DARK = 'rgba(200, 205, 220, 0.6)';
const PAGE_OUTLINE_LIGHT = 'rgba(100, 116, 139, 0.8)';
const PAGE_OUTLINE_DARK = 'rgba(148, 163, 184, 0.8)';
const TAG_LABEL_LIGHT = '#15803d';
const TAG_LABEL_DARK = '#4ade80';
const LINK_LIT_LIGHT = 'rgba(37, 99, 235, 0.75)';
const LINK_LIT_DARK = 'rgba(147, 197, 253, 0.9)';
const LINK_DIM_LIGHT = 'rgba(148, 163, 184, 0.08)';
const LINK_DIM_DARK = 'rgba(200, 205, 220, 0.1)';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const BASE_NODE_REL_SIZE = 6;
const MIN_NODE_REL_SIZE = 0.5;
const MAX_NODE_REL_SIZE = 150;
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
 *
 * Links are also stable-sorted tag edges first: the engine paints links in
 * array order, so this yields the draw order tag edges → tag nodes → page
 * link edges → … (nodes always paint after all links).
 */
function toEngineLinks(edges: AugmentedGraphEdge[]): AugmentedGraphEdge[] {
  return edges
    .map(edge => ({ ...edge }))
    .sort((a, b) => (a.kind === 'tag' ? 0 : 1) - (b.kind === 'tag' ? 0 : 1));
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Zoom scale fitting a bbox of the given graph-space size into a container
 * of the given pixel size, leaving `padding` px of margin.
 */
function fitScale(
  bboxW: number,
  bboxH: number,
  containerW: number,
  containerH: number,
  padding: number
): number {
  const availW = Math.max(containerW - padding * 2, 1);
  const availH = Math.max(containerH - padding * 2, 1);
  return Math.min(availW / Math.max(bboxW, 1), availH / Math.max(bboxH, 1));
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

const isFiniteNumber = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Fallback destination set for pages with no wiki links. */
const NO_LINK_TARGETS: ReadonlySet<string> = new Set();

/** Showdown recomputes at most this often while the engine is ticking. */
export const SHOWDOWN_RECOMPUTE_MS = 100;
/** Approximate per-character width when no 2D context exists (tests/jsdom). */
const FALLBACK_CHAR_WIDTH = 0.6;
/**
 * Whether canvas ctx.filter is supported (Safari lacks it for a long time).
 * Probed once on an offscreen canvas; filters degrade to shadow spreads.
 */
const SUPPORTS_CANVAS_FILTER = (() => {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.filter = 'blur(1px)';
    return ctx.filter !== 'none';
  } catch {
    return false;
  }
})();

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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ForceGraphHandle | null>(null);
  // Mirrors zoomToFitOnRef for the toggle button's pressed rendering.
  const [zoomToFitOn, setZoomToFitOn] = useState(true);

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
  const prevNodeCountRef = useRef<number | null>(null);
  /**
   * Reactive zoom-to-fit: when on, the camera refits on engine stop and data
   * changes. Manual zooms (buttons, wheel) disarm it, "right before" applying.
   */
  const zoomToFitOnRef = useRef(true);
  /** Last-known container pixel size; feeds focus-fit scale math. */
  const containerSizeRef = useRef({ width: 0, height: 0 });
  /** Member count per tag node id (kind-'tag' edges); scales tag springs. */
  const tagMemberCountsRef = useRef(new Map<string, number>());
  /** Unique wiki-link destinations per page id; scales page-link springs. */
  const linkTargetsRef = useRef(new Map<string, Set<string>>());
  /** Dead wiki-links per source page id; scales broken-link springs. */
  const deadLinksBySourceRef = useRef(new Map<string, number>());
  /** Showdown survivors: labels allowed to draw this kind's labels. */
  const pageSurvivorsRef = useRef<Set<string>>(new Set());
  const tagSurvivorsRef = useRef<Set<string>>(new Set());
  /** Throttle clock for tick-driven showdown recomputes. */
  const nextTickComputeAtRef = useRef(0);
  /** Offscreen 2D context for label measurement; null where unsupported. */
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Set by the mount effect so later effects can restyle without re-running
  // the graph setup. Accessors live inside the mount effect: they close over
  // refs only, so they never need reactive dependencies.
  /**
   * Tag-node visibility: the global Tags toggle wins; otherwise focus mode
   * filters — a focused page keeps only its connected tags, a focused tag
   * hides all other tags.
   */
  const isTagNodeVisible = (node: AugmentedGraphNode): boolean => {
    if (!tagsVisibleRef.current) return false;
    if (!focusedIdRef.current) return true;
    return focusSetsRef.current?.neighborIds.has(node.id) ?? false;
  };
  const zoomStylesRef = useRef<(fg: ForceGraphHandle, k: number) => void>(
    () => {}
  );
  const repaintRef = useRef<(fg: ForceGraphHandle) => void>(() => {});

  // Showdown recompute reads only refs, so every effect/callback can call the
  // latest instance through this ref without stale-closure hazards.
  const computeShowdownsRef = useRef(() => {});
  computeShowdownsRef.current = () => {
    const k = zoomRef.current.k;
    const pageCandidates: ShowdownCandidate[] = [];
    const tagCandidates: ShowdownCandidate[] = [];
    if (isFiniteNumber(k) && k > 0) {
      const measureCtx = measureCtxRef.current;
      const measure = (label: string, fontSize: number) => {
        if (measureCtx) {
          measureCtx.font = `${fontSize}px Inter, system-ui, sans-serif`;
          return measureCtx.measureText(label).width;
        }
        return label.length * fontSize * FALLBACK_CHAR_WIDTH;
      };
      for (const node of nodesRef.current) {
        const positioned = node as PositionedNode;
        if (positioned.x === undefined || positioned.y === undefined) continue;
        const isTag = node.kind === 'tag';
        if (isTag && !isTagNodeVisible(node)) continue;
        // Showdown is the sole label selector: every positioned node is a
        // candidate, ranked by score (importance), culled by overlap.

        const fontSize = Math.max(11 / k, 4);
        const label = isTag ? `#${node.title}` : node.title;
        const halfW = measure(label, fontSize) / 2 + 2 / k;
        const radius = Math.sqrt(node._val ?? 1) * nodeRelSizeRef.current;
        const rect = isTag
          ? {
              // Tag labels center inside the disc; no scrim band.
              x1: positioned.x - halfW,
              y1: positioned.y - fontSize / 2,
              x2: positioned.x + halfW,
              y2: positioned.y + fontSize / 2,
            }
          : {
              // Page labels sit below the node; rect covers text + scrim.
              x1: positioned.x - halfW,
              y1: positioned.y + radius + 2 / k,
              x2: positioned.x + halfW,
              y2: positioned.y + radius + 2 / k + fontSize + 3 / k,
            };
        (isTag ? tagCandidates : pageCandidates).push({
          id: node.id,
          score: node._val ?? (isTag ? 0 : 1),
          rect,
        });
      }
    }
    pageSurvivorsRef.current = selectShowdownSurvivors(pageCandidates);
    tagSurvivorsRef.current = selectShowdownSurvivors(tagCandidates);
  };

  useEffect(() => {
    const canvas = document.createElement('canvas');
    measureCtxRef.current = canvas.getContext('2d');
    return () => {
      measureCtxRef.current = null;
    };
  }, []);

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
      theme.pageOutline = dark ? PAGE_OUTLINE_DARK : PAGE_OUTLINE_LIGHT;
      theme.tagLabel = dark ? TAG_LABEL_DARK : TAG_LABEL_LIGHT;
    };
    const theme = {
      linkColor: LINK_COLOR_LIGHT,
      brokenLink: BROKEN_LINK_LIGHT,
      litLink: LINK_LIT_LIGHT,
      dimLink: LINK_DIM_LIGHT,
      tagFill: TAG_FILL_LIGHT,
      tagRing: TAG_RING_LIGHT,
      pageOutline: PAGE_OUTLINE_LIGHT,
      tagLabel: TAG_LABEL_LIGHT,
    };
    applyThemeColors();

    const isBrokenLink = (link: AugmentedGraphEdge) =>
      link.kind === 'link' &&
      nodesByIdRef.current.get(edgeEndpointId(link.target))?.exists === false;

    const nodeColorAccessor = (node: AugmentedGraphNode): string => {
      const focus = focusSetsRef.current;
      const dimmed = focus !== null && !focus.neighborIds.has(node.id);
      if (node.kind === 'tag') {
        if (!isTagNodeVisible(node)) return TRANSPARENT;
        return dimmed ? TAG_DIM : theme.tagFill;
      }
      if (!node.exists) return dimmed ? PLACEHOLDER_DIM : PLACEHOLDER_AMBER;
      return dimmed ? PAGE_DIM : PAGE_BLUE;
    };

    const linkWidthAccessor = (link: AugmentedGraphEdge): number => {
      if (link.kind === 'tag') {
        const tagNode = nodesByIdRef.current.get(edgeEndpointId(link.target));
        return tagNode && isTagNodeVisible(tagNode) ? 0.5 : 0;
      }
      const focus = focusSetsRef.current;
      if (!focus) return baseLinkWidthRef.current;
      if (focus.touchingEdgeKeys.has(edgeKey(link)))
        return baseLinkWidthRef.current * 2;
      return 0.05;
    };

    const linkColorAccessor = (link: AugmentedGraphEdge): string => {
      if (link.kind === 'tag') {
        const tagNode = nodesByIdRef.current.get(edgeEndpointId(link.target));
        if (!tagNode || !isTagNodeVisible(tagNode)) return TRANSPARENT;
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

    const nodeValAccessor = (node: AugmentedGraphNode): number => {
      const base = node._val ?? 1;
      if (node.kind === 'tag' && !isTagNodeVisible(node)) return base * 0.05;
      return base;
    };

    const nodeLabelAccessor = (node: AugmentedGraphNode): string => {
      if (node.kind === 'tag') {
        return isTagNodeVisible(node) ? `#${node.title}` : '';
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
      const radius = Math.sqrt(node._val ?? 1) * nodeRelSizeRef.current;

      if (node.kind === 'page') {
        // Outline in the link-edge slate hue (theme-aware). The unlit link
        // alpha (0.3) is tuned for receding hairline EDGES — far too faint
        // for a node ring — so outlines carry their own stronger constants.
        // Dimmed pages outline in the dimmed edge color so the spotlight
        // reads consistently.
        ctx.beginPath();
        ctx.arc(positioned.x, positioned.y, radius, 0, 2 * Math.PI);
        ctx.strokeStyle = dimmed
          ? theme.dimLink
          : node.exists
            ? theme.pageOutline
            : PLACEHOLDER_AMBER;
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
    };

    // Label pass: runs in onRenderFramePost, AFTER the full scene (nodes +
    // links), so an overlapping node disc painted later can never bury
    // another node's label.
    const paintLabels = (
      ctx: CanvasRenderingContext2D,
      globalScale: number
    ) => {
      for (const node of nodesRef.current) {
        const positioned = node as PositionedNode;
        if (positioned.x === undefined || positioned.y === undefined) continue;
        const focus = focusSetsRef.current;
        const dimmed = focus !== null && !focus.neighborIds.has(node.id);
        if (dimmed) continue;
        if (node.kind === 'tag' && !tagsVisibleRef.current) continue;
        // Showdown survivor sets (recomputed on push/zoom/throttled ticks)
        // decide which labels draw. Applied unconditionally — no focus
        // special case, since dimmed nodes already continue above.
        const survivors =
          node.kind === 'tag'
            ? tagSurvivorsRef.current
            : pageSurvivorsRef.current;
        if (!survivors.has(node.id)) continue;

        const fontSize = Math.max(11 / globalScale, 4);
        const radius = Math.sqrt(node._val ?? 1) * nodeRelSizeRef.current;
        ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = node.kind === 'tag' ? `#${node.title}` : node.title;
        const isTag = node.kind === 'tag';
        const textWidth = ctx.measureText(label).width;
        // Page labels sit below the node; tag labels center inside it, so the
        // big translucent tag discs read as labeled chips.
        const textY = isTag
          ? positioned.y - fontSize / 2
          : positioned.y + radius + 3 / globalScale;

        // Legibility over tag labels and link lines: a blurred scrim behind
        // the text where ctx.filter is supported (Chromium/Firefox), else a
        // spread shadow painted behind an opaque band; plus a tight dark
        // shadow under the glyphs themselves in both cases (the green tag
        // text has no scrim band and needs it most).
        const pad = 3 / globalScale;
        const scrimX = positioned.x - textWidth / 2 - pad;
        const scrimY = textY - pad;
        const scrimW = textWidth + pad * 2;
        const scrimH = fontSize + pad * 2;
        if (!isTag) {
          if (SUPPORTS_CANVAS_FILTER) {
            ctx.save();
            ctx.filter = 'blur(2px)';
            ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
            ctx.fillRect(scrimX, scrimY, scrimW, scrimH);
            ctx.restore();
          } else {
            ctx.save();
            ctx.shadowColor = 'rgba(15, 23, 42, 0.9)';
            ctx.shadowBlur = 3 / globalScale;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
            ctx.fillRect(scrimX, scrimY, scrimW, scrimH);
            ctx.restore();
          }
        }
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
        ctx.shadowBlur = 2 / globalScale;
        ctx.fillStyle = isTag ? theme.tagLabel : 'rgba(255, 255, 255, 0.92)';
        ctx.fillText(label, positioned.x, textY);
        ctx.restore();
      }
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

    // Layout forces: tag edges are short springs binding member pages to
    // their tag node, with per-edge strength inversely proportional to the
    // tag's member count: small distinctive tags pull hard, big tags pull
    // weakly and drift outward under tag↔tag repulsion. Page links pull
    // gently, fading fast with linkedness (see pageLinkSpringStrength);
    // broken links pull hard so a defect's two halves (linking page +
    // missing target) sit adjacent. Accessors must return finite numbers for
    // every edge — d3 unary-pluses them into the force arrays.
    const linkForce = fg.d3Force('link') as D3LinkForce | undefined;
    if (linkForce) {
      linkForce.distance(link =>
        link.kind === 'tag' || isBrokenLink(link)
          ? WIKI_TAG_LINK_DISTANCE
          : WIKI_PAGE_LINK_DISTANCE
      );
      linkForce.strength(link =>
        link.kind === 'tag'
          ? tagSpringStrength(
              tagMemberCountsRef.current.get(edgeEndpointId(link.target)) ?? 1
            )
          : isBrokenLink(link)
            ? brokenLinkSpringStrength(
                deadLinksBySourceRef.current.get(edgeEndpointId(link.source)) ??
                  1
              )
            : pageLinkSpringStrength(
                linkTargetsRef.current.get(edgeEndpointId(link.source)) ??
                  NO_LINK_TARGETS,
                linkTargetsRef.current.get(edgeEndpointId(link.target)) ??
                  NO_LINK_TARGETS
              )
      );
    }
    const chargeForce = fg.d3Force('charge') as D3ChargeForce | undefined;
    if (chargeForce) {
      chargeForce.strength(WIKI_CHARGE_STRENGTH);
    }

    // Cluster separation is tag↔tag-only (see createTagRepulsionForce); the
    // stock charge force repels tags from their own members, which expelled
    // them to the periphery.
    fg.d3Force(
      'tagRepulsion',
      createTagRepulsionForce(WIKI_TAG_REPULSION_STRENGTH)
    );

    const repaint = () => {
      // The render loop repaints continuously; re-setting an accessor-bearing
      // prop simply guarantees the next frame exists even when idle.
      fg.nodeRelSize(nodeRelSizeRef.current);
    };
    repaintRef.current = repaint;

    const applySize = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        containerSizeRef.current = { width: rect.width, height: rect.height };
        fg.width(rect.width).height(rect.height);
      }
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
      // Plain strings are broken here: the engine's accessorFn treats a
      // string prop as a property NAME to look up per node (node['after'] =
      // undefined), so a string mode silently disables custom node painting
      // entirely. The mode must be a function.
      .nodeCanvasObjectMode(() => 'after')
      .nodeLabel(nodeLabelAccessor)
      .linkWidth(linkWidthAccessor)
      .linkColor(linkColorAccessor)
      .linkLineDash(linkDashAccessor)
      .linkDirectionalArrowLength(link => (link.kind === 'tag' ? 0 : 4))
      .onNodeClick(node => {
        if (node.kind === 'tag' && !isTagNodeVisible(node)) return;
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
        computeShowdownsRef.current();
      })
      .onRenderFramePost(paintLabels)
      .onEngineTick(() => {
        const now = performance.now();
        if (now >= nextTickComputeAtRef.current) {
          nextTickComputeAtRef.current = now + SHOWDOWN_RECOMPUTE_MS;
          computeShowdownsRef.current();
        }
      })
      .onEngineStop(() => {
        computeShowdownsRef.current();
        if (zoomToFitOnRef.current && !focusedIdRef.current) {
          if (
            nodesRef.current.some(
              n => isFiniteNumber(n.x) && isFiniteNumber(n.y)
            )
          ) {
            fg.zoomToFit(FIT_MS, FIT_PADDING);
          }
        }
        setZoomToFitOn(zoomToFitOnRef.current);
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

    // Manual zoom via scroll wheel disarms zoom-to-fit. Capture phase on the
    // container fires BEFORE the engine's d3-zoom listener (registered on the
    // same element non-capturing), so the toggle state is consistent with the
    // zoom that actually applies.
    const disarmOnWheel = (event: WheelEvent) => {
      if (!event.defaultPrevented && event.deltaY !== 0) {
        zoomToFitOnRef.current = false;
        setZoomToFitOn(false);
      }
    };
    const root = rootRef.current;
    if (root) {
      // Capture on the component root so it fires before the engine's
      // d3-zoom listener deeper in the tree.
      root.addEventListener('wheel', disarmOnWheel, { capture: true });
    }

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', applySize);
      rootRef.current?.removeEventListener('wheel', disarmOnWheel, {
        capture: true,
      });
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
    tagMemberCountsRef.current = new Map();
    deadLinksBySourceRef.current = new Map();
    for (const edge of edges) {
      if (edge.kind === 'tag') {
        const tagId = edgeEndpointId(edge.target);
        tagMemberCountsRef.current.set(
          tagId,
          (tagMemberCountsRef.current.get(tagId) ?? 0) + 1
        );
      } else if (
        nodesByIdRef.current.get(edgeEndpointId(edge.target))?.exists === false
      ) {
        const sourceId = edgeEndpointId(edge.source);
        deadLinksBySourceRef.current.set(
          sourceId,
          (deadLinksBySourceRef.current.get(sourceId) ?? 0) + 1
        );
      }
    }
    linkTargetsRef.current = new Map();
    for (const edge of edges) {
      if (edge.kind !== 'link') continue;
      const sourceId = edgeEndpointId(edge.source);
      const targetId = edgeEndpointId(edge.target);
      if (!linkTargetsRef.current.has(sourceId))
        linkTargetsRef.current.set(sourceId, new Set());
      if (!linkTargetsRef.current.has(targetId))
        linkTargetsRef.current.set(targetId, new Set());
      linkTargetsRef.current.get(sourceId)!.add(targetId);
      linkTargetsRef.current.get(targetId)!.add(sourceId);
    }
    // Draw order = array order in the engine (last drawn sits on top, and
    // hover/click hit-testing picks the topmost drawn node). Stable-sort a
    // copy so pages always layer above tag nodes — visually AND for pointer
    // reception. The prop array itself stays unmutated for the page memo.
    const orderedNodes = [...nodes].sort(
      (a, b) => (a.kind === 'page' ? 1 : 0) - (b.kind === 'page' ? 1 : 0)
    );
    fg.graphData({ nodes: orderedNodes, links: toEngineLinks(edges) });
    computeShowdownsRef.current();
    zoomStylesRef.current(fg, zoomRef.current.k);
    prevNodeCountRef.current = nodes.length;
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
      // Fit the highlighted neighborhood (focus + 1-hop neighbors) into the
      // viewport: not the whole graph, not an extreme close-up of one node.
      const highlight = focusSetsRef.current;
      if (highlight) {
        const points = nodesRef.current
          .filter(n => highlight.neighborIds.has(n.id))
          .map(n => ({
            x: (n as PositionedNode).x,
            y: (n as PositionedNode).y,
          }))
          .filter(
            (p): p is { x: number; y: number } =>
              isFiniteNumber(p.x) && isFiniteNumber(p.y)
          );
        if (points.length > 0) {
          const xs = points.map(p => p.x);
          const ys = points.map(p => p.y);
          const { width: cw, height: ch } = containerSizeRef.current;
          const k = fitScale(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
            cw,
            ch,
            FIT_PADDING
          );
          fg.centerAt(
            (Math.max(...xs) + Math.min(...xs)) / 2,
            (Math.max(...ys) + Math.min(...ys)) / 2,
            FIT_MS
          );
          fg.zoom(clamp(k, MIN_ZOOM_K, MAX_ZOOM_K), FIT_MS);
        }
      }
    } else if (zoomToFitOnRef.current) {
      // Clear-focus refit only while zoom-to-fit is armed. Before the
      // simulation positions nodes the bbox is NaN and a fit would poison
      // the camera transform; skip until positions exist.
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
      ref={rootRef}
      data-testid="wiki-graph-container"
      className="relative w-full flex-1 min-h-[480px]"
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
          onClick={() => {
            // Manual zoom disarms zoom-to-fit right before it applies.
            zoomToFitOnRef.current = false;
            setZoomToFitOn(false);
            handleRef.current?.zoom(
              clamp(zoomRef.current.k * ZOOM_STEP, MIN_ZOOM_K, MAX_ZOOM_K),
              200
            );
          }}
        >
          +
        </button>
        <button
          type="button"
          data-testid="wiki-graph-zoom-out"
          aria-label="Zoom out"
          className="flex h-8 w-8 items-center justify-center rounded-md border bg-background/80 text-sm backdrop-blur hover:bg-accent"
          onClick={() => {
            zoomToFitOnRef.current = false;
            setZoomToFitOn(false);
            handleRef.current?.zoom(
              clamp(zoomRef.current.k / ZOOM_STEP, MIN_ZOOM_K, MAX_ZOOM_K),
              200
            );
          }}
        >
          −
        </button>
        <button
          type="button"
          data-testid="wiki-graph-zoom-reset"
          aria-label="Toggle zoom to fit"
          aria-pressed={zoomToFitOn}
          title="Zoom to fit"
          className={`flex h-8 w-8 items-center justify-center rounded-md border text-xs backdrop-blur hover:bg-accent ${
            zoomToFitOn
              ? 'bg-primary text-primary-foreground'
              : 'bg-background/80'
          }`}
          onClick={() => {
            const next = !zoomToFitOnRef.current;
            zoomToFitOnRef.current = next;
            setZoomToFitOn(next);
            if (next) {
              handleRef.current?.zoomToFit(FIT_MS, FIT_PADDING);
            }
          }}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
