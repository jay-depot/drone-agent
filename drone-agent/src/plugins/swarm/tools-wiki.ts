/**
 * Wiki tool definitions for the swarm plugin.
 *
 * Provides tools to read, write, search, list, delete, and lint
 * wiki pages in the swarm knowledge base.
 */

import type { DroneToolDefinition } from 'drone-core';
import type { SwarmContext } from './context.js';

function createWikiReadTool(ctx: SwarmContext): DroneToolDefinition {
  return {
    name: 'wiki_read',
    description: 'Read a wiki page from the swarm knowledge base by ID.',
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
        return JSON.stringify({ success: true, page: await res.json() });
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
    defaultHidden: true,
    description:
      'Create or update a wiki page in the swarm knowledge base.',
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
          description:
            'Optional session log IDs that contributed to this page',
        },
      },
      required: ['pageId', 'title', 'content'],
    },
    execute: async params => {
      const { pageId, title, content, scope, tags, sources } = params;
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
    description: 'Search wiki pages in the swarm knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
      },
      required: ['query'],
    },
    execute: async params => {
      const query = params.query as string;
      try {
        const res = await fetch(
          `${ctx.baseUrl}/wiki/search?q=${encodeURIComponent(query)}`
        );
        if (!res.ok) {
          return JSON.stringify({ success: false, error: 'Search failed' });
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
    defaultHidden: true,
    description: 'Delete a wiki page from the swarm knowledge base.',
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
      const pageId = params.pageId as string;
      const scope = params.scope as string | undefined;
      let url = `${ctx.baseUrl}/wiki/${encodeURIComponent(pageId)}`;
      if (scope) url += `?scope=${scope}`;
      try {
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok) {
          return JSON.stringify({
            success: false,
            error: 'Failed to delete wiki page',
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
export function createWikiTools(
  ctx: SwarmContext
): DroneToolDefinition[] {
  return [
    createWikiReadTool(ctx),
    createWikiWriteTool(ctx),
    createWikiSearchTool(ctx),
    createWikiListTool(ctx),
    createWikiDeleteTool(ctx),
    createWikiLintTool(ctx),
  ];
}
