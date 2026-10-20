/**
 * Wiki tool definitions for the swarm plugin.
 *
 * Provides tools to read, write, search, list, delete, and lint
 * wiki pages in the swarm knowledge base.
 */

import type { DroneToolDefinition } from 'drone-core';
import type { SwarmContext } from './context.js';
import { firstMissingString } from './string-params.js';

function createWikiReadTool(ctx: SwarmContext): DroneToolDefinition {
  return {
    name: 'wiki_read',
    description:
      'Read wiki page(s) from the swarm knowledge base by ID. ' +
      'Without a scope, returns ALL versions of the page (beacon and/or coordinator), ' +
      'each tagged with its "origin". With ?scope, returns exactly that version as a single page.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The page ID to read',
        },
        scope: {
          type: 'string',
          enum: ['beacon', 'coordinator'],
          description: 'Optional scope filter (beacon or coordinator)',
        },
      },
      required: ['pageId'],
    },
    execute: async params => {
      const missing = firstMissingString(params, ['pageId']);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `wiki_read requires a non-empty ${missing}.`,
        });
      }
      const pageId = params.pageId as string;
      const scope = params.scope as string | undefined;
      let url = `${ctx.baseUrl}/wiki/${encodeURIComponent(pageId)}`;
      if (scope) url += `?scope=${scope}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          return JSON.stringify({
            success: false,
            error: `Wiki page not found: ${pageId}`,
          });
        }
        const data = (await res.json()) as Record<string, unknown>;
        if (
          !scope &&
          data &&
          Array.isArray((data as { versions?: unknown[] }).versions)
        ) {
          return JSON.stringify({
            success: true,
            pages: (data as { versions: unknown[] }).versions,
          });
        }
        return JSON.stringify({ success: true, page: data });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `Failed to read wiki page: ${err}`,
        });
      }
    },
  };
}

function createWikiWriteTool(ctx: SwarmContext): DroneToolDefinition {
  return {
    name: 'wiki_write',
    description: 'Create or update a wiki page in the swarm knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The page ID (filesystem-safe slug)',
        },
        title: {
          type: 'string',
          description: 'Human-readable title',
        },
        content: {
          type: 'string',
          description: 'Markdown body content',
        },
        scope: {
          type: 'string',
          enum: ['beacon', 'coordinator'],
          description: 'Scope (beacon or coordinator). Default: beacon',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional session log IDs that contributed to this page',
        },
        pitch: {
          type: 'string',
          description:
            'Optional one-sentence summary of what this page is about (shown in swarm memory RAG results)',
        },
      },
      required: ['pageId', 'title', 'content'],
    },
    execute: async params => {
      const missing = firstMissingString(params, [
        'pageId',
        'title',
        'content',
      ]);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `wiki_write requires a non-empty ${missing}.`,
        });
      }
      const { pageId, title, content, scope, tags, sources, pitch } = params;
      try {
        const res = await fetch(
          `${ctx.baseUrl}/wiki/${encodeURIComponent(pageId as string)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              content,
              scope: scope || 'beacon',
              tags: tags || [],
              sources: sources || [],
              ...(pitch ? { pitch } : {}),
            }),
          }
        );
        if (!res.ok) {
          const err = await res.json();
          return JSON.stringify({
            success: false,
            error: err.error || 'Failed to write wiki page',
          });
        }
        return JSON.stringify({ success: true, page: await res.json() });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `Failed to write wiki page: ${err}`,
        });
      }
    },
  };
}

function createWikiSearchTool(ctx: SwarmContext): DroneToolDefinition {
  return {
    name: 'wiki_search',
    description:
      'Semantically query wiki pages in the swarm knowledge base. Your query is ' +
      'embedded into a vector and matched by meaning, so the search works best ' +
      'if you format your query as a well-formed question or sentence. Returns ' +
      'page metadata and the best-matching chunk for each page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of pages to return (default 10, max 50)',
        },
        minScore: {
          type: 'number',
          description:
            'Minimum cosine similarity score (0.0-1.0); lower-scoring pages are dropped',
        },
      },
      required: ['query'],
    },
    execute: async params => {
      const missing = firstMissingString(params, ['query']);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `wiki_search requires a non-empty ${missing}.`,
        });
      }
      const query = params.query as string;

      const searchParams = new URLSearchParams({ q: query });
      if (typeof params.maxResults === 'number') {
        searchParams.set('maxResults', String(params.maxResults));
      }
      if (typeof params.minScore === 'number') {
        searchParams.set('minScore', String(params.minScore));
      }

      try {
        const res = await fetch(
          `${ctx.baseUrl}/wiki/semantic-search?${searchParams.toString()}`
        );
        if (res.status === 503) {
          return JSON.stringify({
            success: false,
            error:
              'Semantic wiki search is unavailable: the beacon has no embedding provider. ' +
              'Use wiki_list to browse pages instead.',
          });
        }
        if (!res.ok) {
          return JSON.stringify({
            success: false,
            error: `Wiki search failed (HTTP ${res.status})`,
          });
        }
        return JSON.stringify({ success: true, results: await res.json() });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `Failed to search wiki: ${err}`,
        });
      }
    },
  };
}

function createWikiListTool(ctx: SwarmContext): DroneToolDefinition {
  return {
    name: 'wiki_list',
    description: 'List all wiki pages in the swarm knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        const res = await fetch(`${ctx.baseUrl}/wiki`);
        if (!res.ok) {
          return JSON.stringify({
            success: false,
            error: 'Failed to list wiki pages',
          });
        }
        return JSON.stringify({ success: true, pages: await res.json() });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `Failed to list wiki pages: ${err}`,
        });
      }
    },
  };
}

function createWikiDeleteTool(ctx: SwarmContext): DroneToolDefinition {
  return {
    name: 'wiki_delete',
    description:
      'Delete a wiki page from the swarm knowledge base. Without a scope, ' +
      'deletes ALL versions of the page (beacon and coordinator). With a ' +
      'scope, deletes only that version.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The page ID to delete',
        },
        scope: {
          type: 'string',
          enum: ['beacon', 'coordinator'],
          description: 'Optional scope filter (beacon or coordinator)',
        },
      },
      required: ['pageId'],
    },
    execute: async params => {
      const missing = firstMissingString(params, ['pageId']);
      if (missing) {
        return JSON.stringify({
          success: false,
          error: `wiki_delete requires a non-empty ${missing}.`,
        });
      }
      const pageId = params.pageId as string;
      const scope = params.scope as string | undefined;
      let url = `${ctx.baseUrl}/wiki/${encodeURIComponent(pageId)}`;
      if (scope) url += `?scope=${scope}`;
      try {
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok) {
          const err = await res.json();
          return JSON.stringify({
            success: false,
            error: err.error || 'Failed to delete wiki page',
          });
        }
        return JSON.stringify({ success: true, result: await res.json() });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `Failed to delete wiki page: ${err}`,
        });
      }
    },
  };
}

function createWikiLintTool(ctx: SwarmContext): DroneToolDefinition {
  return {
    name: 'wiki_lint',
    description:
      'Run a lint pass on the local wiki to check for broken links, downward links, and orphan pages.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        const res = await fetch(`${ctx.baseUrl}/wiki/lint`, { method: 'POST' });
        if (!res.ok) {
          return JSON.stringify({ success: false, error: 'Lint failed' });
        }
        return JSON.stringify({ success: true, issues: await res.json() });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `Failed to lint wiki: ${err}`,
        });
      }
    },
  };
}

/**
 * Create all wiki tool definitions.
 */
export function createWikiTools(ctx: SwarmContext): DroneToolDefinition[] {
  return [
    createWikiReadTool(ctx),
    createWikiWriteTool(ctx),
    createWikiSearchTool(ctx),
    createWikiListTool(ctx),
    createWikiDeleteTool(ctx),
    createWikiLintTool(ctx),
  ];
}
