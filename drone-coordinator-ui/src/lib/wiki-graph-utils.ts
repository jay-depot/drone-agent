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
 * Layout spread: link rest length and per-node repulsion. Higher values
 * spread connected nodes further apart; tuned for label legibility.
 */
export const WIKI_LINK_DISTANCE = 90;
export const WIKI_CHARGE_STRENGTH = -240;

/**
 * Fraction of the graph's max wiki-link degree that earns a label at low
 * zoom, so small graphs (max degree < LABEL_THRESHOLD_MAX_DEGREE) still
 * show hub labels instead of none at all.
 */
export const LABEL_THRESHOLD_LOW_FRACTION = 0.35;
/**
 * Stable key for an edge endpoint: engine-resolved links carry node objects
 * where our canonical edges carry id strings, so match by resolved id.
 */
export function edgeEndpointId(endpoint: unknown): string {
  if (typeof endpoint === 'object' && endpoint !== null) {
    return String((endpoint as { id: unknown }).id);
  }
  return String(endpoint);
}

/** `source\\u0000target` key for an edge, endpoint-form agnostic. */
export function edgeKey(edge: { source: unknown; target: unknown }): string {
  return `${edgeEndpointId(edge.source)}\\u0000${edgeEndpointId(edge.target)}`;
}

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

  const maxWords = Math.max(
    0,
    ...nodes.filter(node => node.kind === 'page').map(node => node.wordCount)
  );
  const logMaxWords = Math.log10(1 + maxWords);

  return nodes.map(node => {
    if (node.kind === 'tag') {
      // Tag size encodes absolute member count (area-proportional in the
      // engine: radius = sqrt(val) * relSize), not a normalized share.
      return { ...node, _val: tagMemberCounts.get(node.id) ?? 0 };
    }
    const normDegree =
      maxPageDegree > 0 ? (linkDegrees.get(node.id) ?? 0) / maxPageDegree : 0;
    const normWords =
      logMaxWords > 0 ? Math.log10(1 + node.wordCount) / logMaxWords : 0;
    const importance = 0.7 * normDegree + 0.3 * normWords;
    return { ...node, _val: Math.pow(1 + NODE_SIZE_SPREAD * importance, 1.5) };
  });
}

/**
 * Highest label threshold for a graph: a fraction of its max wiki-link
 * degree, clamped to [2, LABEL_THRESHOLD_MAX_DEGREE], so the low-zoom end
 * always names a meaningful handful of hubs regardless of graph size.
 */
export function maxLabelThreshold(maxDegree: number): number {
  if (maxDegree <= 0) return 0;
  return Math.min(
    LABEL_THRESHOLD_MAX_DEGREE,
    Math.max(2, Math.ceil(maxDegree * LABEL_THRESHOLD_LOW_FRACTION))
  );
}

/**
 * Label visibility threshold for a given zoom level: at low zoom only
 * high-degree hubs carry labels; as zoom increases the threshold drops
 * linearly to 0 (everything labeled). Scaled to the graph's own degree
 * distribution via maxLabelThreshold.
 */
export function labelDegreeThreshold(k: number, maxDegree: number): number {
  const top = maxLabelThreshold(maxDegree);
  if (k <= LABEL_THRESHOLD_MIN_ZOOM) return top;
  if (k >= LABEL_THRESHOLD_MAX_ZOOM) return 0;
  const t =
    (k - LABEL_THRESHOLD_MIN_ZOOM) /
    (LABEL_THRESHOLD_MAX_ZOOM - LABEL_THRESHOLD_MIN_ZOOM);
  return Math.max(0, Math.min(top, top * (1 - t)));
}

export interface FocusSets {
  /** The focused node id plus every neighbor reachable by one edge. */
  neighborIds: Set<string>;
  /**
   * `source\\u0000target` keys of edges touching the focused node. Keys (not
   * object identity) because the graph engine hands accessors its own
   * endpoint-resolved link objects, not the canonical edge instances.
   */
  touchingEdgeKeys: Set<string>;
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
  const touchingEdgeKeys = new Set<string>();
  for (const edge of edges) {
    if (edge.source === focusedId || edge.target === focusedId) {
      neighborIds.add(edge.source);
      neighborIds.add(edge.target);
      touchingEdgeKeys.add(edgeKey(edge));
    }
  }
  return { neighborIds, touchingEdgeKeys };
}
