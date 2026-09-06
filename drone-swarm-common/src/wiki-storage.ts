import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  DroneWikiPage,
  DroneWikiPageMeta,
  DroneWikiSearchResult,
  DroneWikiTagCount,
} from 'drone-core';

/**
 * Default directory for the swarm knowledge base on the beacon host.
 */
const DEFAULT_KB_DIR = './knowledge-base';

let kbDir = DEFAULT_KB_DIR;

export function setKnowledgeBaseDir(dir: string): void {
  kbDir = dir;
}

function getKbDir(): string {
  return kbDir;
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the frontmatter object and the body content.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();
      // Parse arrays: [item1, item2]
      if (
        typeof value === 'string' &&
        value.startsWith('[') &&
        value.endsWith(']')
      ) {
        value = value
          .slice(1, -1)
          .split(',')
          .map(s => s.trim().replace(/^"(.*)"$/, '$1'))
          .filter(Boolean);
      }
      // Parse booleans
      if (value === 'true') value = true;
      if (value === 'false') value = false;
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: match[2].trimStart() };
}

/**
 * Build YAML frontmatter string from metadata.
 */
function buildFrontmatter(meta: DroneWikiPageMeta): string {
  const lines = ['---'];
  lines.push(`id: ${meta.id}`);
  lines.push(`title: ${meta.title}`);
  lines.push(`scope: ${meta.scope}`);
  lines.push(`tags: [${meta.tags.map(t => `"${t}"`).join(', ')}]`);
  lines.push(`sources: [${meta.sources.map(s => `"${s}"`).join(', ')}]`);
  if (meta.pitch) {
    lines.push(`pitch: ${meta.pitch}`);
  }
  lines.push(`createdAt: ${meta.createdAt}`);
  lines.push(`updatedAt: ${meta.updatedAt}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * Resolve the filesystem path for a wiki page.
 */
function pagePath(pageId: string): string {
  // Sanitize page ID to prevent path traversal
  const safe = pageId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getKbDir(), `${safe}.md`);
}

/**
 * Maximum allowed wiki content length (1MB) to prevent polynomial regex
 * execution on uncontrolled input. This is a safety bound; real wiki pages
 * are far smaller.
 */
const MAX_WIKI_CONTENT_LENGTH = 1_000_000;

/**
 * Extract [[wiki links]] from markdown content.
 * Returns a list of linked page IDs.
 */
function extractWikiLinks(content: string): string[] {
  if (content.length > MAX_WIKI_CONTENT_LENGTH) {
    throw new Error(
      `Wiki content exceeds maximum allowed length of ${MAX_WIKI_CONTENT_LENGTH} characters`
    );
  }

  const links: string[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

/**
 * Check if a link from a source page to a target page violates
 * the "no linking downwards" rule.
 */
function isDownwardLink(
  sourceScope: 'beacon' | 'coordinator',
  targetScope: 'beacon' | 'coordinator'
): boolean {
  // Coordinator pages cannot link to beacon pages
  return sourceScope === 'coordinator' && targetScope === 'beacon';
}

/**
 * Resolve the scope of a page by reading its file.
 * Returns undefined if the page doesn't exist.
 */
async function resolvePageScope(
  pageId: string
): Promise<'beacon' | 'coordinator' | undefined> {
  try {
    // pagePath sanitizes pageId to [a-zA-Z0-9_-], neutralizing traversal.
    // codeql[js/path-injection]
    const raw = await readFile(pagePath(pageId), 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    const scope = frontmatter.scope as string | undefined;
    if (scope === 'beacon' || scope === 'coordinator') return scope;
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Create or update a wiki page.
 * Enforces the "no linking downwards" rule on write.
 */
export async function writePage(
  id: string,
  title: string,
  scope: 'beacon' | 'coordinator',
  content: string,
  tags: string[] = [],
  sources: string[] = [],
  pitch?: string
): Promise<DroneWikiPage> {
  if (id.toLowerCase() === 'tags') {
    throw new Error(
      'Page id "tags" is reserved; it conflicts with the wiki tag index route.'
    );
  }

  const now = new Date().toISOString();

  // Check for existing page to preserve createdAt
  let createdAt = now;
  try {
    // pagePath sanitizes pageId to [a-zA-Z0-9_-], neutralizing traversal.
    // codeql[js/path-injection]
    const existing = await readFile(pagePath(id), 'utf-8');
    const { frontmatter } = parseFrontmatter(existing);
    createdAt = (frontmatter.createdAt as string) || now;
  } catch {
    // New page
  }

  // Extract wiki links and enforce "no linking downwards"
  const links = extractWikiLinks(content);
  for (const linkId of links) {
    const targetScope = await resolvePageScope(linkId);
    if (targetScope && isDownwardLink(scope, targetScope)) {
      throw new Error(
        `Cannot link from ${scope}-scoped page "${id}" to ${targetScope}-scoped page "${linkId}". ` +
          `Coordinator-scoped pages cannot link to beacon-scoped pages.`
      );
    }
  }

  const meta: DroneWikiPageMeta = {
    id,
    title,
    scope,
    tags,
    sources,
    ...(pitch ? { pitch } : {}),
    createdAt,
    updatedAt: now,
  };

  const fullContent = buildFrontmatter(meta) + '\n' + content;

  await mkdir(getKbDir(), { recursive: true });
  // pagePath sanitizes pageId to [a-zA-Z0-9_-], neutralizing traversal.
  // codeql[js/path-injection]
  await writeFile(pagePath(id), fullContent, 'utf-8');

  return { ...meta, content };
}

/**
 * Read a wiki page by ID.
 */
export async function readPage(pageId: string): Promise<DroneWikiPage | null> {
  try {
    // pagePath sanitizes pageId to [a-zA-Z0-9_-], neutralizing traversal.
    // codeql[js/path-injection]
    const raw = await readFile(pagePath(pageId), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const pitch = frontmatter.pitch as string | undefined;

    return {
      id: (frontmatter.id as string) || pageId,
      title: (frontmatter.title as string) || pageId,
      scope: (frontmatter.scope as 'beacon' | 'coordinator') || 'beacon',
      tags: (frontmatter.tags as string[]) || [],
      sources: (frontmatter.sources as string[]) || [],
      ...(pitch ? { pitch } : {}),
      createdAt: (frontmatter.createdAt as string) || new Date().toISOString(),
      updatedAt: (frontmatter.updatedAt as string) || new Date().toISOString(),
      content: body,
    };
  } catch {
    return null;
  }
}

/**
 * Delete a wiki page.
 */
export async function deletePage(pageId: string): Promise<boolean> {
  try {
    // pagePath sanitizes pageId to [a-zA-Z0-9_-], neutralizing traversal.
    // codeql[js/path-injection]
    await rm(pagePath(pageId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all wiki pages with their metadata.
 */
export async function listPages(tag?: string): Promise<DroneWikiPageMeta[]> {
  try {
    const files = await readdir(getKbDir());
    const pages: DroneWikiPageMeta[] = [];

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const pageId = file.slice(0, -3);
      const page = await readPage(pageId);
      if (page) {
        pages.push({
          id: page.id,
          title: page.title,
          scope: page.scope,
          tags: page.tags,
          sources: page.sources,
          ...(page.pitch ? { pitch: page.pitch } : {}),
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        });
      }
    }

    const filtered = tag ? pages.filter(p => p.tags.includes(tag)) : pages;

    return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

/**
 * List all distinct tags across pages with their page counts,
 * sorted by count descending then tag ascending.
 */
export async function listTags(): Promise<DroneWikiTagCount[]> {
  const pages = await listPages();
  const counts = new Map<string, number>();

  for (const page of pages) {
    for (const tag of page.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Search wiki pages by query string.
 * Simple substring search on title, tags, and content.
 */
export async function searchPages(
  query: string
): Promise<DroneWikiSearchResult[]> {
  const q = query.toLowerCase();
  const pages = await listPages();
  const results: DroneWikiSearchResult[] = [];

  for (const meta of pages) {
    const page = await readPage(meta.id);
    if (!page) continue;

    const contentLower = page.content.toLowerCase();
    const titleLower = page.title.toLowerCase();
    const tagMatch = page.tags.some(t => t.toLowerCase().includes(q));

    let score = 0;
    let snippet = '';
    // Title match (highest score)
    if (titleLower.includes(q)) {
      score = 1.0;
      snippet = page.content.slice(0, 200).replace(/\n/g, ' ');
    }
    // Tag match
    else if (tagMatch) {
      score = 0.8;
      snippet = page.content.slice(0, 200).replace(/\n/g, ' ');
    }
    // Content match
    else if (contentLower.includes(q)) {
      const idx = contentLower.indexOf(q);
      const start = Math.max(0, idx - 80);
      const end = Math.min(page.content.length, idx + 120);
      snippet =
        (start > 0 ? '...' : '') +
        page.content.slice(start, end).replace(/\n/g, ' ') +
        (end < page.content.length ? '...' : '');
      score = 0.5;
    }

    if (score > 0) {
      results.push({ page: meta, snippet, score });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Run a lint pass on the wiki.
 * Checks for:
 * - Broken [[wiki links]] (links to non-existent pages)
 * - Downward links from coordinator to beacon pages
 * - Orphan pages (no inbound links)
 */
export async function lintPages(): Promise<{
  issues: Array<{ type: string; pageId: string; detail: string }>;
}> {
  const issues: Array<{ type: string; pageId: string; detail: string }> = [];
  const pages = await listPages();
  const pageIds = new Set(pages.map(p => p.id));

  // Build inbound link map
  const inboundLinks = new Map<string, string[]>();
  for (const p of pages) {
    inboundLinks.set(p.id, []);
  }

  for (const meta of pages) {
    const page = await readPage(meta.id);
    if (!page) continue;

    let links: string[];
    try {
      links = extractWikiLinks(page.content);
    } catch {
      // Skip link extraction for oversized pages (graceful degradation)
      // NOTE: Future enhancement could add a "page too long" warning here
      continue;
    }

    for (const linkId of links) {
      // Check for broken links
      if (!pageIds.has(linkId)) {
        issues.push({
          type: 'broken-link',
          pageId: meta.id,
          detail: `Links to non-existent page "${linkId}"`,
        });
        continue;
      }

      // Track inbound links
      const existing = inboundLinks.get(linkId) || [];
      existing.push(meta.id);
      inboundLinks.set(linkId, existing);

      // Check for downward links
      const targetScope = await resolvePageScope(linkId);
      if (targetScope && isDownwardLink(meta.scope, targetScope)) {
        issues.push({
          type: 'downward-link',
          pageId: meta.id,
          detail: `Links from ${meta.scope}-scoped page to ${targetScope}-scoped page "${linkId}"`,
        });
      }
    }
  }

  // Check for orphan pages
  for (const meta of pages) {
    const inbounds = inboundLinks.get(meta.id) || [];
    if (inbounds.length === 0) {
      issues.push({
        type: 'orphan',
        pageId: meta.id,
        detail: 'No inbound links from other pages',
      });
    }
  }

  return { issues };
}

/**
 * A node in the wiki connected-graph view.
 */
export type WikiGraphNode = {
  /** Page id, or the raw link target for a broken-link placeholder node. */
  id: string;
  /** Page title, or the raw link target for a broken-link placeholder node. */
  title: string;
  /** False for broken-link placeholder nodes (a linked page that doesn't exist). */
  exists: boolean;
  /** Number of whitespace-separated words in the page body (0 for placeholders). */
  wordCount: number;
  tags: string[];
  pitch?: string;
  scope: 'beacon' | 'coordinator';
};

/**
 * A directed edge in the wiki graph: `source` links to `target` via a
 * [[wikilink]]. Reverse/incoming direction is derived in the UI.
 */
export type WikiGraphEdge = {
  source: string;
  target: string;
  kind: 'link';
};

/**
 * The full connected-graph view of the wiki: one node per page (including
 * orphans) plus placeholder nodes for broken-link targets, and forward edges
 * for each [[wikilink]]. Used to power the coordinator UI graph view.
 */
export type WikiGraph = {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
};

/**
 * Build the connected-graph view of the wiki from the stored pages.
 * Every page becomes a node; [[wikilinks]] become forward edges. Link targets
 * that do not resolve to a page are added as `exists:false` placeholder nodes
 * so missing pages are visible in the graph. Edges are deduplicated.
 */
export async function buildGraph(): Promise<WikiGraph> {
  const metas = await listPages();
  const pageIds = new Set(metas.map(m => m.id));

  const nodesById = new Map<string, WikiGraphNode>();
  const edgeKeys = new Set<string>();
  const edges: WikiGraphEdge[] = [];

  for (const meta of metas) {
    const page = await readPage(meta.id);
    if (!page) continue;
    const wordCount = page.content.split(/\s+/).filter(Boolean).length;
    nodesById.set(page.id, {
      id: page.id,
      title: page.title,
      exists: true,
      wordCount,
      tags: page.tags,
      ...(page.pitch ? { pitch: page.pitch } : {}),
      scope: page.scope,
    });

    let links: string[];
    try {
      links = extractWikiLinks(page.content);
    } catch {
      // Skip link extraction for oversized pages (graceful degradation),
      // matching lintPages.
      links = [];
    }
    for (const target of links) {
      const edgeKey = `${page.id}\u0000${target}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edges.push({ source: page.id, target, kind: 'link' });
      }
      if (!pageIds.has(target) && !nodesById.has(target)) {
        nodesById.set(target, {
          id: target,
          title: target,
          exists: false,
          wordCount: 0,
          tags: [],
          scope: page.scope,
        });
      }
    }
  }

  return { nodes: [...nodesById.values()], edges };
}
