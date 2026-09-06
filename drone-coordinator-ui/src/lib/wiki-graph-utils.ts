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
 * Tag-layer forces: stiff short springs pull member pages into tight
 * topical clusters, while a dedicated tag↔tag-only repulsion force pushes
 * the clusters apart. (The stock charge force repels tags from their own
 * members too — a scalar per node cannot distinguish neighbors — which
 * expelled tag nodes to the graph periphery.)
 *
 * Big tags need disproportionate separation: their many member springs
 * anchor them to the same centroid when member sets overlap. The
 * inverse-square term therefore scales with the geometric mean of the two
 * tags' member counts, and a soft exclusion shell (sized by the tags'
 * rendered radii) makes close crowding impossible. Per-pair kicks are
 * clamped so stronger forces cannot launch nodes explosively.
 */
export const WIKI_TAG_LINK_DISTANCE = 55;
export const WIKI_TAG_SPRING_STRENGTH = 1;
export const WIKI_TAG_REPULSION_STRENGTH = 900;
export const WIKI_TAG_REPULSION_DISTANCE_MAX = 500;
export const WIKI_TAG_MIN_SEPARATION_SCALE = 4.5;
export const WIKI_TAG_SEPARATION_STRENGTH = 40;
export const WIKI_TAG_MAX_KICK = 25;

/**
 * d3 link-force default strength (1 / min degree of the two endpoints,
 * counting every edge in the layout), reproduced so page-link springs keep
 * their stock behavior while tag springs are stiffened per edge kind.
 */
export function d3DefaultLinkStrength(
  edge: { source: unknown; target: unknown },
  totalEdgeDegrees: Map<string, number>
): number {
  const sourceDegree = totalEdgeDegrees.get(edgeEndpointId(edge.source)) ?? 0;
  const targetDegree = totalEdgeDegrees.get(edgeEndpointId(edge.target)) ?? 0;
  const minDegree = Math.min(sourceDegree, targetDegree);
  return minDegree > 0 ? 1 / minDegree : 0;
}

/**
 * Member count for a tag node (its rendered size source). Falls back to the
 * single `tags` entry for synthetic fixtures.
 */
function tagMembers(node: SimNode): number {
  if (node._val && node._val > 0) return node._val;
  return node.tags.length || 1;
}

/**
 * Rendered graph-space radius: the engine draws radius =
 * sqrt(nodeVal) * nodeRelSize / 2, and the component's zoom compensation
 * sets nodeRelSize ~= 6/k, canceling k at constant screen size. Uses the
 * base 6 so the shell matches on-screen appearance at any zoom.
 */
function tagRadius(node: SimNode): number {
  return (Math.sqrt(node._val ?? 1) * 6) / 2;
}

/** A simulation node as d3 sees it: position + velocity fields. */
export type SimNode = AugmentedGraphNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
};

/**
 * A d3-compatible force ((alpha) => void) that repels tag nodes from each
 * other only — pages are untouched, so clusters keep their members while
 * separate topics drift apart. Registered via the graph engine's
 * `d3Force(name, force)` setter; d3 re-runs `initialize` whenever the node
 * set changes, so the tag list stays current across data pushes.
 */
export type TagRepulsionForce = {
  (alpha: number): void;
  initialize(nodes: SimNode[]): void;
};

export function createTagRepulsionForce(strength: number): TagRepulsionForce {
  let tagNodes: SimNode[] = [];

  const force = (alpha: number) => {
    const k = strength * alpha;
    for (let i = 0; i < tagNodes.length; i++) {
      const a = tagNodes[i];
      if (a.x === undefined || a.y === undefined) continue;
      for (let j = i + 1; j < tagNodes.length; j++) {
        const b = tagNodes[j];
        if (b.x === undefined || b.y === undefined) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq === 0) {
          // Coincident tags: nudge apart along +x at unit distance so the
          // kick stays bounded (f = k / distSq would explode near zero).
          dy = 0;
          dx = 1;
          distSq = 1;
        }
        const dist = Math.sqrt(distSq);

        // Size-scaled inverse-square: big tags (many members) repel
        // proportionally to the geometric mean of their member counts.
        const sizeFactor = Math.sqrt(
          Math.max(1, tagMembers(a)) * Math.max(1, tagMembers(b))
        );
        let kick = 0;
        if (distSq <= WIKI_TAG_REPULSION_DISTANCE_MAX ** 2) {
          kick += (k * sizeFactor) / distSq;
        }

        // Soft exclusion shell: tags may not crowd inside the sum of their
        // rendered radii (the engine renders radius = sqrt(val) * relSize /
        // 2 scaled by zoom compensation); spring-like push when violated.
        const minDist =
          tagRadius(a) + tagRadius(b) + WIKI_TAG_MIN_SEPARATION_SCALE;
        if (dist < minDist) {
          const overlap = minDist - dist;
          kick += overlap * WIKI_TAG_SEPARATION_STRENGTH * alpha;
        }

        if (kick === 0) continue;
        const fx = (dx / dist) * Math.min(kick, WIKI_TAG_MAX_KICK);
        const fy = (dy / dist) * Math.min(kick, WIKI_TAG_MAX_KICK);
        a.vx = (a.vx ?? 0) + fx;
        a.vy = (a.vy ?? 0) + fy;
        b.vx = (b.vx ?? 0) - fx;
        b.vy = (b.vy ?? 0) - fy;
      }
    }
  };

  (force as TagRepulsionForce).initialize = (nodes: SimNode[]) => {
    tagNodes = nodes.filter(node => node.kind === 'tag');
  };
  return force as TagRepulsionForce;
}

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
