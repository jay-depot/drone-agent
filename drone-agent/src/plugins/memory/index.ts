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

    // memory.manage — store, recall, delete
    registration.registerTool({
      name: 'manage',
      description:
        'Manage memory entries: store, recall, or delete. ' +
        'Use action="store" with key+value to save, action="recall" with key to retrieve, ' +
        'action="delete" with key to remove.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['store', 'recall', 'delete'],
            description:
              'What to do: store (save), recall (retrieve), delete (remove).',
          },
          key: {
            type: 'string',
            description: 'Memory key (required for all actions).',
          },
          value: {
            type: 'string',
            description: 'Text value to store (required for store action).',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorization (store action only).',
          },
        },
        required: ['action', 'key'],
        additionalProperties: false,
      },
      execute: async input => {
        const action = input.action as string;
        const key = (input.key as string).trim();
        if (!key) throw new Error('memory.manage requires a non-empty key.');

        if (action === 'store') {
          const value = input.value as string;
          if (typeof value !== 'string') {
            throw new Error('memory.manage store requires a string value.');
          }
          const tags = Array.isArray(input.tags)
            ? (input.tags as string[]).filter(t => typeof t === 'string')
            : [];
          const entry = await capability.store(key, value, tags);
          return JSON.stringify(
            { key: entry.key, tags: entry.tags, createdAt: entry.createdAt },
            null,
            2
          );
        }

        if (action === 'recall') {
          const entry = await capability.recall(key);
          if (!entry) {
            return JSON.stringify(
              { key, entry: null, message: 'No entry found for this key.' },
              null,
              2
            );
          }
          return JSON.stringify(entry, null, 2);
        }

        if (action === 'delete') {
          const removed = await capability.delete(key);
          return JSON.stringify({ key, removed }, null, 2);
        }

        throw new Error(`Unknown action: ${action}`);
      },
    });

    // memory.browse — list, search
    registration.registerTool({
      name: 'browse',
      description:
        'Browse memory entries: list all (optionally filtered by prefix) or search by substring.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'search'],
            description:
              'What to do: list (by prefix) or search (by substring).',
          },
          prefix: {
            type: 'string',
            description: 'Key prefix filter (for list action).',
          },
          query: {
            type: 'string',
            description:
              'Substring to search for (for search action, case-insensitive).',
          },
          limit: {
            type: 'number',
            description: 'Maximum results (for search action, default 50).',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async input => {
        const action = input.action as string;

        if (action === 'list') {
          const prefix =
            typeof input.prefix === 'string' ? input.prefix : undefined;
          const entries = await capability.list(prefix);
          return JSON.stringify(
            { count: entries.length, prefix: prefix ?? null, entries },
            null,
            2
          );
        }

        if (action === 'search') {
          const query = input.query as string;
          if (typeof query !== 'string' || query.trim().length === 0) {
            throw new Error(
              'memory.browse search requires a non-empty query string.'
            );
          }
          const limit =
            typeof input.limit === 'number' && input.limit > 0
              ? Math.floor(input.limit)
              : 50;
          const results = await capability.search(query.trim(), limit);
          return JSON.stringify(
            { count: results.length, query, results },
            null,
            2
          );
        }

        throw new Error(`Unknown action: ${action}`);
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
