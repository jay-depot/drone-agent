import { useEffect, useRef } from 'react';
import ForceGraph from 'force-graph';
import type { WikiGraphEdge, WikiGraphNode } from '@/lib/types';

/**
 * Minimal structural type for the parts of the force-graph API we use, so the
 * real library can be swapped without touching consumers. The imperative
 * handle returned by the factory exposes chainable setters and callbacks.
 */
export interface ForceGraphHandle {
  graphData(data: {
    nodes: WikiGraphNode[];
    links: WikiGraphEdge[];
  }): ForceGraphHandle;
  nodeId(key: string): ForceGraphHandle;
  linkSource(key: string): ForceGraphHandle;
  linkTarget(key: string): ForceGraphHandle;
  nodeRelSize(size: number): ForceGraphHandle;
  nodeColor(accessor: (node: WikiGraphNode) => string): ForceGraphHandle;
  linkDirectionalArrowLength(length: number): ForceGraphHandle;
  linkWidth(width: number): ForceGraphHandle;
  linkColor(color: string): ForceGraphHandle;
  onNodeClick(cb: (node: WikiGraphNode) => void): ForceGraphHandle;
  onBackgroundClick(cb: () => void): ForceGraphHandle;
  width(px: number): ForceGraphHandle;
  height(px: number): ForceGraphHandle;
  zoomToFit(durationMs?: number, padding?: number): ForceGraphHandle;
}

function defaultFactory(el: HTMLElement): ForceGraphHandle {
  // force-graph's default export is a class with the imperative API above.
  // The instance type is structurally compatible with ForceGraphHandle.
  return new (
    ForceGraph as unknown as new (el: HTMLElement) => ForceGraphHandle
  )(el);
}

const LINK_COLOR_LIGHT = 'rgba(148, 163, 184, 0.4)';
const LINK_COLOR_DARK = 'rgba(200, 205, 220, 0.7)';

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

export default function WikiGraphView({
  nodes,
  edges,
  focusedNodeId,
  onNodeFocus,
  onClearFocus,
  forceGraphFactory = defaultFactory,
}: {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  focusedNodeId?: string | null;
  onNodeFocus: (pageId: string) => void;
  onClearFocus: () => void;
  forceGraphFactory?: (el: HTMLElement) => ForceGraphHandle;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ForceGraphHandle | null>(null);

  // Keep latest callbacks without re-instantiating the graph.
  const cbRef = useRef({ onNodeFocus, onClearFocus });
  cbRef.current = { onNodeFocus, onClearFocus };
  const linkColorRef = useRef(LINK_COLOR_LIGHT);
  const applyLinkColor = (fg: ForceGraphHandle) => {
    fg.linkColor(linkColorRef.current);
  };
  const sizeRef = useRef({ width: 0, height: 0 });
  const measureContainer = () => {
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : sizeRef.current;
  };
  const applySize = (fg: ForceGraphHandle) => {
    const size = measureContainer();
    sizeRef.current = size;
    fg.width(size.width).height(size.height);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fg = forceGraphFactory(el);
    handleRef.current = fg;
    linkColorRef.current = isDarkMode() ? LINK_COLOR_DARK : LINK_COLOR_LIGHT;
    applySize(fg);

    const { onNodeFocus: focus, onClearFocus: clear } = cbRef.current;
    fg.nodeId('id')
      .linkSource('source')
      .linkTarget('target')
      .nodeRelSize(6)
      .linkDirectionalArrowLength(4)
      .linkWidth(1.5)
      .nodeColor(node => (node.exists ? '#2563eb' : '#d97706'))
      .linkColor(linkColorRef.current)
      .onNodeClick(node => focus(String(node.id)))
      .onBackgroundClick(() => clear());

    // Re-apply the link color when the root theme class flips (dark ⇄ light).
    // force-graph renders to a canvas, so CSS alone can't recolor the edges;
    // we have to push a new color through the API.
    const observer = new MutationObserver(() => {
      linkColorRef.current = isDarkMode() ? LINK_COLOR_DARK : LINK_COLOR_LIGHT;
      applyLinkColor(handleRef.current!);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: false,
    });

    // Keep the canvas sized to the container when the window resizes.
    const onResize = () => {
      const handle = handleRef.current;
      if (handle) applySize(handle);
    };
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      (fg as unknown as { _destructor?: () => void })._destructor?.();
      handleRef.current = null;
    };
  }, [forceGraphFactory]);

  // Push data + focus into the graph whenever they change.
  useEffect(() => {
    const fg = handleRef.current;
    if (!fg) return;
    fg.graphData({ nodes, links: edges });
    // Re-apply size in case the layout settled after mount (e.g. late CSS).
    applySize(fg);
    if (focusedNodeId) {
      // Highlight the focused node by making it larger.
      fg.nodeRelSize(10);
    } else {
      fg.nodeRelSize(6);
    }
  }, [nodes, edges, focusedNodeId]);

  return (
    <div
      ref={containerRef}
      data-testid="wiki-graph-container"
      className="w-full h-[calc(100vh-220px)] min-h-[480px]"
    />
  );
}
