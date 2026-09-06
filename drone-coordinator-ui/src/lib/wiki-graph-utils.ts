import type {
  AugmentedGraphEdge,
  AugmentedGraphNode,
  AugmentedWikiGraph,
  WikiGraph,
} from '@/lib/types';

/** Spread constant for the node-size formula: `_val = (1 + SPREAD * importance)^1.5`. */
export const NODE_SIZE_SPREAD = 2;

/** Zoom level at or below which only the highest-degree hubs are labeled. */
export const LABEL_THRESHOLD_MIN_ZOOM = 0.75;

/** Zoom level at or above which every visible node is labeled. */
export const LABEL_THRESHOLD_MAX_ZOOM = 2.5;

/** Wiki-link degree required for a label at or below LABEL_THRESHOLD_MIN_ZOOM. */
export const LABEL_THRESHOLD_MAX_DEGREE = 10;

/**
 * Count wiki-link degree (in + out) per node id, over `kind: 'link'` edges
 * only. Tag edges are excluded so heavily-tagged pages do not fake hub status.
 */
export function wikiLinkDegrees(
  edges: AugmentedGraphEdge[]
): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== 'link') continue;
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  return degrees;
}

/**
 * Derive the tag layer from page tags: one tag node per unique tag
 * (`tag:<tag>` id) plus one `kind: 'tag'` edge per page→tag pair. The tag
 * layer organizes layout via attraction; visibility is a render concern.
 */
export function buildAugmentedWikiGraph(graph: WikiGraph): AugmentedWikiGraph {
  const nodes: AugmentedGraphNode[] = graph.nodes.map(node => ({
    ...node,
    kind: 'page' as const,
  }));
  const edges: AugmentedGraphEdge[] = graph.edges.map(edge => ({ ...edge }));

  const tagNodes = new Map<string, AugmentedGraphNode>();
  for (const node of graph.nodes) {
    for (const tag of node.tags) {
      const id = `tag:${tag}`;
      if (!tagNodes.has(id)) {
        tagNodes.set(id, {
          id,
          title: tag,
          exists: true,
          wordCount: 0,
          tags: [tag],
          scope: node.scope,
          kind: 'tag',
        });
      }
      edges.push({ source: node.id, target: id, kind: 'tag' });
    }
  }

  return { nodes: [...nodes, ...tagNodes.values()], edges };
}

/**
 * Drop pages with zero wiki-link degree (orphans) together with their edges,
 * then drop tag nodes left without any edge. Tag nodes with remaining member
 * pages survive and keep pulling their neighborhoods together.
 */
export function filterOrphans(graph: AugmentedWikiGraph): AugmentedWikiGraph {
  const degrees = wikiLinkDegrees(graph.edges);
  const keptNodes = graph.nodes.filter(
    node => node.kind === 'tag' || (degrees.get(node.id) ?? 0) > 0
  );
  const keptIds = new Set(keptNodes.map(node => node.id));
  const keptEdges = graph.edges.filter(
    edge => keptIds.has(edge.source) && keptIds.has(edge.target)
  );

  const tagIdsWithEdges = new Set<string>();
  for (const edge of keptEdges) {
    if (edge.kind === 'tag') {
      tagIdsWithEdges.add(edge.target);
    }
  }

  return {
    nodes: keptNodes.filter(
      node => node.kind === 'page' || tagIdsWithEdges.has(node.id)
    ),
    edges: keptEdges,
  };
}

/**
 * Compute per-node size values for the force-graph `nodeVal` accessor.
 * Page importance blends normalized wiki-link degree (weight 0.7) with
 * log-normalized word count (weight 0.3); tag nodes use their member count
 * in place of degree (word weight 0). Returns new node objects carrying
 * `_val`, suitable for pushing straight into `graphData`.
 */
export function applyNodeSizing(
  nodes: AugmentedGraphNode[],
  edges: AugmentedGraphEdge[]
): AugmentedGraphNode[] {
  const linkDegrees = wikiLinkDegrees(edges);
  const maxPageDegree = Math.max(0, ...linkDegrees.values());

  const tagMemberCounts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind === 'tag') {
      tagMemberCounts.set(
        edge.target,
        (tagMemberCounts.get(edge.target) ?? 0) + 1
      );
    }
  }
  const maxMembers = Math.max(0, ...tagMemberCounts.values());

  const maxWords = Math.max(
    0,
    ...nodes.filter(node => node.kind === 'page').map(node => node.wordCount)
  );
  const logMaxWords = Math.log10(1 + maxWords);

  return nodes.map(node => {
    let importance: number;
    if (node.kind === 'tag') {
      importance =
        maxMembers > 0
          ? 0.7 * ((tagMemberCounts.get(node.id) ?? 0) / maxMembers)
          : 0;
    } else {
      const normDegree =
        maxPageDegree > 0 ? (linkDegrees.get(node.id) ?? 0) / maxPageDegree : 0;
      const normWords =
        logMaxWords > 0 ? Math.log10(1 + node.wordCount) / logMaxWords : 0;
      importance = 0.7 * normDegree + 0.3 * normWords;
    }
    return { ...node, _val: Math.pow(1 + NODE_SIZE_SPREAD * importance, 1.5) };
  });
}

/**
 * Label visibility threshold for a given zoom level: at low zoom only
 * high-degree hubs carry labels; as zoom increases the threshold drops
 * linearly to 0 (everything labeled). Clamped to [0, LABEL_THRESHOLD_MAX_DEGREE].
 */
export function labelDegreeThreshold(k: number): number {
  if (k <= LABEL_THRESHOLD_MIN_ZOOM) return LABEL_THRESHOLD_MAX_DEGREE;
  if (k >= LABEL_THRESHOLD_MAX_ZOOM) return 0;
  const t =
    (k - LABEL_THRESHOLD_MIN_ZOOM) /
    (LABEL_THRESHOLD_MAX_ZOOM - LABEL_THRESHOLD_MIN_ZOOM);
  return Math.max(
    0,
    Math.min(LABEL_THRESHOLD_MAX_DEGREE, LABEL_THRESHOLD_MAX_DEGREE * (1 - t))
  );
}

export interface FocusSets {
  /** The focused node id plus every neighbor reachable by one edge. */
  neighborIds: Set<string>;
  /** Edges touching the focused node (object identity from the input array). */
  touchingEdges: Set<AugmentedGraphEdge>;
}

/**
 * Compute the dim-and-spotlight sets for a focused node: which nodes stay
 * lit (the focus + direct neighbors, including tag edges when the focus is
 * a tag node) and which edges stay bright.
 */
export function buildFocusSets(
  edges: AugmentedGraphEdge[],
  focusedId: string
): FocusSets {
  const neighborIds = new Set<string>([focusedId]);
  const touchingEdges = new Set<AugmentedGraphEdge>();
  for (const edge of edges) {
    if (edge.source === focusedId || edge.target === focusedId) {
      neighborIds.add(edge.source);
      neighborIds.add(edge.target);
      touchingEdges.add(edge);
    }
  }
  return { neighborIds, touchingEdges };
}
