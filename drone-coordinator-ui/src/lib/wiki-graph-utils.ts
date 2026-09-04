import type { WikiGraph } from '@/lib/types';

/**
 * Compute the focused subgraph: the node with `focusedNodeId` plus its direct
 * in/out neighbors, and only the edges touching it. Used by the wiki graph
 * view to focus/expand on a clicked node.
 */
export function buildFocusedSubgraph(
  graph: WikiGraph,
  focusedNodeId: string
): WikiGraph {
  const nodeIds = new Set<string>([focusedNodeId]);
  const edges = graph.edges.filter(
    e => e.source === focusedNodeId || e.target === focusedNodeId
  );
  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  return {
    nodes: graph.nodes.filter(n => nodeIds.has(n.id)),
    edges,
  };
}
