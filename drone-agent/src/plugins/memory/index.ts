import type { DronePlugin, DronePromptFragment } from 'drone-core';
import { MemoryManageBlock } from '../../tui/components/MemoryManageBlock.js';
import { MemoryBrowseBlock } from '../../tui/components/MemoryBrowseBlock.js';
import process from 'node:process';
import {
  createMemoryEntry,
  deleteMemoryEntry,
  listMemoryEntries,
  readMemoryEntry,
  resolveMemoryDir,
  sanitizeKey,
  searchMemoryEntries,
  updateMemoryEntry,
  writeMemoryEntry,
  countMemoryEntries as countStoreEntries,
} from './store.js';
import { withKeyLock } from '../../shared/keyed-lock.js';
import type { DroneMemoryCapability, MemoryEntry } from './types.js';
import {
  parseUnifiedDiff,
  type HunkWithHints,
} from '../../shared/unified-diff-parser.js';
import { applyPatch } from '../../shared/patch-applier.js';
import { renderDiffV2 } from '../../shared/diff-renderer.js';
import { formatPatchError } from '../../shared/patch-applier/errors.js';

/**
 * Recovery hint appended to memory edit patch failures. The shared
 * `formatPatchError` output is deliberately tool-agnostic, so each caller
 * supplies its own "re-read and retry" advice.
 */
const MEMORY_EDIT_RECOVERY_TIP =
  'Tip: recall the entry with memory__manage (action="recall") to confirm its current contents, then correct the diff and try again.';

/**
 * Signals that a `capability.edit` patch callback decided not to commit
 * (e.g. the diff matched no hunks). Thrown from inside the callback so the
 * read-modify-write is abandoned without writing; the tool converts it into
 * a structured error result.
 */
class MemoryEditAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryEditAbort';
  }
}

/**
 * Apply a parsed diff to an entry body, returning the patched text plus the
 * rendered diff and summary for the tool result. Throws `MemoryEditAbort`
 * when no hunk applied, so the caller writes nothing.
 */
function applyPatchToBody(
  key: string,
  body: string,
  hunks: HunkWithHints[]
): {
  value: string;
  diffOutput: string;
  summary: Record<string, unknown>;
  partialFailureMessage?: string;
} {
  const result = applyPatch(body.split('\n'), hunks);
  if (result.appliedHunks.length === 0) {
    throw new MemoryEditAbort(
      `memory.manage edit: no hunks applied to the entry body. ` +
        `${result.errors.map(formatPatchError).join('\n\n')}\n\n` +
        MEMORY_EDIT_RECOVERY_TIP
    );
  }

  const fuzzByIndex = new Map(
    result.appliedHunks.map(a => [a.hunkIndex, a.fuzz])
  );
  const diffHunks = hunks
    .map((hunk, i) => ({ hunk, i }))
    .filter(({ i }) => fuzzByIndex.has(i))
    .map(({ hunk, i }) => ({
      anchors: hunk.anchors,
      contextBefore: hunk.contextBefore,
      changeZone: hunk.changeZone,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
      contextAfter: hunk.contextAfter,
      fuzz: fuzzByIndex.get(i),
    }));
  const rendered = renderDiffV2(`memory:${key}`, diffHunks, false);

  return {
    value: result.patchedLines.join('\n'),
    diffOutput: rendered.plain,
    summary: rendered.summary as unknown as Record<string, unknown>,
    partialFailureMessage: result.success
      ? undefined
      : `memory.manage edit: ${result.errors.length} of ${hunks.length} hunk(s) failed to apply. ` +
        `The entry was written with ${result.appliedHunks.length} successful hunk(s) applied.\n\n` +
        `${result.errors.map(formatPatchError).join('\n\n')}\n\n` +
        MEMORY_EDIT_RECOVERY_TIP,
  };
}

export const memoryPlugin: DronePlugin = {
  metadata: {
    id: 'memory',
    name: 'Memory',
    version: '0.1.0',
    description:
      'Persistent project-level memory: store, recall, edit, search, and delete facts across sessions.',
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
        return withKeyLock(`memory:${sanitizeKey(key)}`, async () => {
          const existing =
            cache.get(key) ?? (await readMemoryEntry(memoryDir, key));
          const entry = existing
            ? updateMemoryEntry(existing, value, tags)
            : createMemoryEntry(key, value, tags);

          cache.set(entry.key, entry);
          await writeMemoryEntry(memoryDir, entry);
          registration.logger.info(`memory stored: ${entry.key}`);
          return entry;
        });
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
        return withKeyLock(`memory:${sanitizeKey(key)}`, async () => {
          cache.delete(key);
          return deleteMemoryEntry(memoryDir, key);
        });
      },

      edit: async (key, patch) => {
        if (!config.enabled) {
          return null;
        }
        return withKeyLock(`memory:${sanitizeKey(key)}`, async () => {
          const existing =
            cache.get(key) ?? (await readMemoryEntry(memoryDir, key));
          if (!existing) {
            return null;
          }
          const { value, tags } = patch(existing);
          const entry = updateMemoryEntry(existing, value, tags);

          cache.set(entry.key, entry);
          await writeMemoryEntry(memoryDir, entry);
          registration.logger.info(`memory edited: ${entry.key}`);
          return entry;
        });
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
        'Manage memory entries: store, recall, edit, or delete. ' +
        'Use action="store" with key+value to save, action="recall" with key to retrieve, ' +
        'action="edit" with key+diff (and/or tags) to surgically patch an existing entry, ' +
        'action="delete" with key to remove.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['store', 'recall', 'edit', 'delete'],
            description:
              'What to do: store (save), recall (retrieve), edit (patch in place), delete (remove).',
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
            description:
              'Optional tags for categorization (store, or edit to replace tags).',
          },
          diff: {
            type: 'string',
            description:
              'Unified diff patch applied to the entry body (required for edit ' +
              'unless tags is given). The @@ hunk header is optional; a ' +
              'headerless patch parses as one hunk and must contain -/+ change lines.',
          },
        },
        required: ['action', 'key'],
        additionalProperties: false,
      },
      execute: async input => {
        const action = input.action as string;

        const key = typeof input.key === 'string' ? input.key.trim() : '';
        if (!key) throw new Error('memory.manage requires a non-empty key.');
        if (
          action !== 'store' &&
          action !== 'recall' &&
          action !== 'edit' &&
          action !== 'delete'
        ) {
          throw new Error(
            'memory.manage action must be store, recall, edit, or delete.'
          );
        }

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

        if (action === 'edit') {
          const diff =
            typeof input.diff === 'string' && input.diff.trim().length > 0
              ? input.diff
              : undefined;
          const tags = Array.isArray(input.tags)
            ? (input.tags as string[]).filter(t => typeof t === 'string')
            : undefined;
          if (!diff && !tags) {
            throw new Error(
              'memory.manage edit requires a diff and/or tags to change.'
            );
          }

          let hunks: HunkWithHints[] = [];
          if (diff) {
            hunks = parseUnifiedDiff(diff);
            if (hunks.length === 0) {
              throw new Error(
                'memory.manage edit: no hunks found in the diff. The patch ' +
                  'must contain `-`/`+` change lines (a headerless patch ' +
                  'parses as one hunk).'
              );
            }
          }

          let diffOutput: string | undefined;
          let summary: Record<string, unknown> | undefined;
          let partialFailureMessage: string | undefined;

          let entry: MemoryEntry | null;
          try {
            entry = await capability.edit(key, existing => {
              if (!diff) {
                return { value: existing.value, tags };
              }
              const patched = applyPatchToBody(key, existing.value, hunks);
              diffOutput = patched.diffOutput;
              summary = patched.summary;
              partialFailureMessage = patched.partialFailureMessage;
              return { value: patched.value, tags };
            });
          } catch (err) {
            if (err instanceof MemoryEditAbort) {
              return JSON.stringify(
                { success: false, key, error: err.message },
                null,
                2
              );
            }
            throw err;
          }

          if (!entry) {
            return JSON.stringify(
              { key, entry: null, message: 'No entry found for this key.' },
              null,
              2
            );
          }
          if (partialFailureMessage) {
            return JSON.stringify(
              { success: false, key, error: partialFailureMessage },
              null,
              2
            );
          }
          return JSON.stringify(
            {
              success: true,
              key: entry.key,
              tags: entry.tags,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
              ...(summary ? { summary } : {}),
              ...(diffOutput !== undefined ? { diff: diffOutput } : {}),
            },
            null,
            2
          );
        }

        if (action === 'delete') {
          const removed = await capability.delete(key);
          return JSON.stringify({ key, removed }, null, 2);
        }

        throw new Error(`Unknown action: ${action}`);
      },
      renderComponent: state => MemoryManageBlock({ state }),
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
        if (action !== 'list' && action !== 'search') {
          throw new Error('memory.browse action must be list or search.');
        }

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
      renderComponent: state => MemoryBrowseBlock({ state }),
    });

    // ── help snippet ───────────────────────────────────────────────────
    registration.registerHelp(
      'Project Memory: store/recall/edit/list/search/delete facts in .drone-agent/memory/. Enabled with --plugin memory.'
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
