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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fg = forceGraphFactory(el);
    handleRef.current = fg;

    const { onNodeFocus: focus, onClearFocus: clear } = cbRef.current;
    fg.nodeId('id')
      .linkSource('source')
      .linkTarget('target')
      .nodeRelSize(6)
      .linkDirectionalArrowLength(4)
      .linkWidth(1.5)
      .nodeColor(node => (node.exists ? '#2563eb' : '#d97706'))
      .onNodeClick(node => focus(String(node.id)))
      .onBackgroundClick(() => clear());

    return () => {
      (fg as unknown as { _destructor?: () => void })._destructor?.();
      handleRef.current = null;
    };
  }, [forceGraphFactory]);

  // Push data + focus into the graph whenever they change.
  useEffect(() => {
    const fg = handleRef.current;
    if (!fg) return;
    fg.graphData({ nodes, links: edges });
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
      className="w-full h-[600px]"
    />
  );
}
