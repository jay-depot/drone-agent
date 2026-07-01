import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  DroneWikiPage,
  DroneWikiPageMeta,
  DroneWikiSearchResult,
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
 * Extract [[wiki links]] from markdown content.
 * Returns a list of linked page IDs.
 */
function extractWikiLinks(content: string): string[] {
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
  sources: string[] = []
): Promise<DroneWikiPage> {
  const now = new Date().toISOString();

  // Check for existing page to preserve createdAt
  let createdAt = now;
  try {
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
    createdAt,
    updatedAt: now,
  };

  const fullContent = buildFrontmatter(meta) + '\n' + content;

  await mkdir(getKbDir(), { recursive: true });
  await writeFile(pagePath(id), fullContent, 'utf-8');

  return { ...meta, content };
}

/**
 * Read a wiki page by ID.
 */
export async function readPage(pageId: string): Promise<DroneWikiPage | null> {
  try {
    const raw = await readFile(pagePath(pageId), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    return {
      id: (frontmatter.id as string) || pageId,
      title: (frontmatter.title as string) || pageId,
      scope: (frontmatter.scope as 'beacon' | 'coordinator') || 'beacon',
      tags: (frontmatter.tags as string[]) || [],
      sources: (frontmatter.sources as string[]) || [],
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
    await rm(pagePath(pageId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all wiki pages with their metadata.
 */
export async function listPages(): Promise<DroneWikiPageMeta[]> {
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
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        });
      }
    }

    return pages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
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

    const links = extractWikiLinks(page.content);

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