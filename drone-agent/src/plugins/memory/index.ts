import type { DronePlugin, DronePromptFragment } from 'drone-core';
import process from 'node:process';
import {
  createMemoryEntry,
  deleteMemoryEntry,
  listMemoryEntries,
  readMemoryEntry,
  resolveMemoryDir,
  searchMemoryEntries,
  updateMemoryEntry,
  writeMemoryEntry,
  countMemoryEntries as countStoreEntries,
} from './store.js';
import type { DroneMemoryCapability, MemoryEntry } from './types.js';

export const memoryPlugin: DronePlugin = {
  metadata: {
    id: 'memory',
    name: 'Memory',
    version: '0.1.0',
    description:
      'Persistent project-level memory: store, recall, search, and delete facts across sessions.',
    defaultEnabled: false,
  },
  register: async registration => {
    const config = registration.getConfig().memory;
    const projectDir = process.cwd();
    const memoryDir = resolveMemoryDir(projectDir);

    // Lazy loader: all loaded entries, keyed by their sanitized key.
    // We keep an in-memory cache so repeated reads avoid disk I/O,
    // but writes always flush to disk immediately.
    const cache = new Map<string, MemoryEntry>();

    // ── capability: DroneMemoryCapability ──────────────────────────────
    const capability: DroneMemoryCapability = {
      store: async (key, value, tags) => {
        if (!config.enabled) {
          throw new Error('Memory is disabled by configuration.');
        }
        const existing =
          cache.get(key) ?? (await readMemoryEntry(memoryDir, key));
        const entry = existing
          ? updateMemoryEntry(existing, value, tags)
          : createMemoryEntry(key, value, tags);

        cache.set(entry.key, entry);
        await writeMemoryEntry(memoryDir, entry);
        registration.logger.info(`memory stored: ${entry.key}`);
        return entry;
      },

      recall: async key => {
        if (!config.enabled) {
          return null;
        }
        const cached = cache.get(key);
        if (cached) {
          return cached;
        }
        const entry = await readMemoryEntry(memoryDir, key);
        if (entry) {
          cache.set(entry.key, entry);
        }
        return entry;
      },

      list: async prefix => {
        if (!config.enabled) {
          return [];
        }
        return listMemoryEntries(memoryDir, prefix);
      },

      search: async (query, limit) => {
        if (!config.enabled) {
          return [];
        }
        return searchMemoryEntries(memoryDir, query, limit);
      },

      delete: async key => {
        if (!config.enabled) {
          return false;
        }
        cache.delete(key);
        return deleteMemoryEntry(memoryDir, key);
      },
    };

    registration.offer(capability);

    // ── prompt fragment: shows recent memories ─────────────────────────
    const memoryFragment: DronePromptFragment = {
      key: 'memory',
      phase: 'header',
      render: async () => {
        if (!config.enabled) {
          return false;
        }
        const entries = await listMemoryEntries(memoryDir);
        if (entries.length === 0) {
          return 'No project memories stored yet. Use `memory.store` to persist facts.';
        }

        // Show the most recent 10 entries
        const recent = entries.slice(0, 10);
        const lines: string[] = ['# Project Memories'];
        for (const entry of recent) {
          const summary =
            entry.key.length > 60 ? entry.key.slice(0, 57) + '...' : entry.key;
          lines.push(`- \`${summary}\` (updated ${entry.updatedAt})`);
        }
        if (entries.length > 10) {
          lines.push(`… and ${entries.length - 10} more.`);
        }
        lines.push(
          'Call `memory.recall` with `{"key": "..."}` to read a specific entry.'
        );
        return lines.join('\n');
      },
    };

    registration.registerPromptFragment(memoryFragment);

    // ── tools ──────────────────────────────────────────────────────────

    // memory.store
    registration.registerTool({
      name: 'store',
      defaultHidden: true,
      description:
        'Store a value under a given key in project-level memory. Overwrites any existing entry with the same key.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Human-readable key for the memory entry (filesystem-safe).',
          },
          value: {
            type: 'string',
            description: 'Arbitrary text value to store.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional free-form tags for categorization.',
          },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.key !== 'string' || input.key.trim().length === 0) {
          throw new Error('memory.store requires a non-empty key string.');
        }
        if (typeof input.value !== 'string') {
          throw new Error('memory.store requires a string value.');
        }
        const tags = Array.isArray(input.tags)
          ? (input.tags as string[]).filter(t => typeof t === 'string')
          : [];
        const entry = await capability.store(
          input.key.trim(),
          input.value,
          tags
        );
        return JSON.stringify(
          { key: entry.key, tags: entry.tags, createdAt: entry.createdAt },
          null,
          2
        );
      },
    });

    // memory.recall
    registration.registerTool({
      name: 'recall',
      description:
        'Retrieve a stored memory entry by its exact key. Returns null if the key does not exist.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'The memory key to look up.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.key !== 'string' || input.key.trim().length === 0) {
          throw new Error('memory.recall requires a non-empty key string.');
        }
        const entry = await capability.recall(input.key.trim());
        if (!entry) {
          return JSON.stringify(
            {
              key: input.key,
              entry: null,
              message: 'No entry found for this key.',
            },
            null,
            2
          );
        }
        return JSON.stringify(entry, null, 2);
      },
    });

    // memory.list
    registration.registerTool({
      name: 'list',
      description:
        'List all stored memory keys, optionally filtered by key prefix. Returns key and last-updated timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            description: 'Optional key prefix to filter by.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const prefix =
          typeof input.prefix === 'string' ? input.prefix : undefined;
        const entries = await capability.list(prefix);
        return JSON.stringify(
          { count: entries.length, prefix: prefix ?? null, entries },
          null,
          2
        );
      },
    });

    // memory.search
    registration.registerTool({
      name: 'search',
      description:
        'Search memory entries by substring match against key, tags, and body text. Returns up to 50 matching entries.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Substring to search for (case-insensitive).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default 50).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async input => {
        if (
          typeof input.query !== 'string' ||
          input.query.trim().length === 0
        ) {
          throw new Error('memory.search requires a non-empty query string.');
        }
        const limit =
          typeof input.limit === 'number' && input.limit > 0
            ? Math.floor(input.limit)
            : 50;
        const results = await capability.search(input.query.trim(), limit);
        return JSON.stringify(
          { count: results.length, query: input.query, results },
          null,
          2
        );
      },
    });

    // memory.delete
    registration.registerTool({
      name: 'delete',
      defaultHidden: true,
      description:
        'Delete a single memory entry by key. Returns whether the entry was removed.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'The memory key to delete.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.key !== 'string' || input.key.trim().length === 0) {
          throw new Error('memory.delete requires a non-empty key string.');
        }
        const removed = await capability.delete(input.key.trim());
        return JSON.stringify({ key: input.key, removed }, null, 2);
      },
    });

    // ── help snippet ───────────────────────────────────────────────────
    registration.registerHelp(
      'Project Memory: store/recall/list/search/delete facts in .drone-agent/memory/. Enabled with --plugin memory.'
    );

    // ── lifecycle hooks ────────────────────────────────────────────────

    // onPluginsLoaded: log memory status and load cache
    registration.hooks.onPluginsLoaded(async () => {
      if (!config.enabled) {
        registration.logger.info('memory plugin disabled by configuration.');
        return;
      }
      const count = await countStoreEntries(memoryDir);
      registration.logger.info(
        `memory plugin ready (${count} stored entry(ies))`
      );
    });
  },
};
