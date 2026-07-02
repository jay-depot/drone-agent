import { isRecord } from '../shared/type-guards.js';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { DronePlugin } from 'drone-core';
import { renderDiffV2 } from '../shared/diff-renderer.js';
import { applyPatch, type PatchHunk } from '../shared/patch-applier.js';

/**
 * Wraps a raw Node.js fs error (ENOENT, EACCES, EISDIR, ...) into a clearer
 * message that names the tool and target path so the LLM can self-correct.
 */
function enhanceFsError(
  toolName: string,
  targetPath: string,
  err: unknown
): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const raw = err instanceof Error ? err.message : String(err);

  switch (code) {
    case 'ENOENT':
      return new Error(
        `${toolName}: path not found: ${targetPath}. Verify the path exists and is spelled correctly.`
      );
    case 'EACCES':
    case 'EPERM':
      return new Error(
        `${toolName}: permission denied for ${targetPath}. The current process cannot read or write this path.`
      );
    case 'EISDIR':
      return new Error(
        `${toolName}: expected a file but ${targetPath} is a directory. Use file__list for directories.`
      );
    case 'ENOTDIR':
      return new Error(
        `${toolName}: expected a directory but ${targetPath} is not one (or a parent path is not a directory).`
      );
    default:
      return new Error(`${toolName} failed for ${targetPath}: ${raw}`);
  }
}

/**
 * @internal Exposed for unit tests. Not part of the public API.
 */
export const __testing = { enhanceFsError };

export const filePlugin: DronePlugin = {
  metadata: {
    id: 'file',
    name: 'File',
    version: '0.2.0',
    description: 'Read, write, list, and patch files in the workspace.',
    defaultEnabled: false,
  },
  register: async registration => {
    // -----------------------------------------------------------------------
    // file__read
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'read',
      description:
        'Read a file (absolute path). Optional 1-based startLine/endLine.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          startLine: { type: 'number', description: 'First line (1-based).' },
          endLine: {
            type: 'number',
            description: 'Last line (1-based, inclusive).',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file__read requires a non-empty path string.');
        }
        const filePath = path.resolve(input.path.trim());
        let content: string;
        try {
          content = await readFile(filePath, 'utf-8');
        } catch (err) {
          throw enhanceFsError('file__read', filePath, err);
        }
        const lines = content.split('\n');

        const startLine =
          typeof input.startLine === 'number' &&
          Number.isFinite(input.startLine)
            ? Math.max(1, Math.floor(input.startLine))
            : 1;
        const endLine =
          typeof input.endLine === 'number' && Number.isFinite(input.endLine)
            ? Math.min(lines.length, Math.floor(input.endLine))
            : lines.length;

        if (startLine > endLine) {
          throw new Error(
            `file__read: startLine (${startLine}) must not exceed endLine (${endLine}).`
          );
        }

        const selected = lines.slice(startLine - 1, endLine);
        return JSON.stringify(
          {
            path: filePath,
            totalLines: lines.length,
            startLine,
            endLine,
            content: selected.join('\n'),
          },
          null,
          2
        );
      },
    });

    // -----------------------------------------------------------------------
    // file__list
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'list',
      description:
        'List a directory (absolute path). Returns names, types, sizes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file__list requires a non-empty path string.');
        }
        const dirPath = path.resolve(input.path.trim());
        let entries: import('node:fs').Dirent[];
        try {
          entries = await readdir(dirPath, { withFileTypes: true });
        } catch (err) {
          throw enhanceFsError('file__list', dirPath, err);
        }
        const items = await Promise.all(
          entries.map(async entry => {
            const fullPath = path.join(dirPath, entry.name);
            let size: number | undefined;
            if (entry.isFile()) {
              try {
                size = (await stat(fullPath)).size;
              } catch {
                // stat may fail for permission reasons
              }
            }
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              size,
            };
          })
        );
        return JSON.stringify({ path: dirPath, items }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // file__write
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'write',
      description:
        'Write content to a file (absolute path). Creates parents; overwrites.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file__write requires a non-empty path string.');
        }
        if (typeof input.content !== 'string') {
          throw new Error('file__write requires a content string.');
        }
        const filePath = path.resolve(input.path.trim());
        try {
          await writeFile(filePath, input.content, 'utf-8');
        } catch (err) {
          throw enhanceFsError('file__write', filePath, err);
        }
        return JSON.stringify({ path: filePath, written: true }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // file__apply_diff
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'apply_diff',
      description:
        'Apply a patch to a file using content-anchored hunks. ' +
        'Each hunk is located by matching context lines in the file, not by line numbers. ' +
        'This makes patches robust to file evolution.\n\n' +
        'Each hunk has:\n' +
        '  - anchors: Optional code lines that uniquely identify the location ' +
        '(e.g., ["class Foo:", "    def bar():"]). Use multiple anchors for ' +
        'disambiguation in nested scopes.\n' +
        '  - contextBefore: 2-3 lines of code immediately above the edit point.\n' +
        '  - oldLines: The exact lines to remove (can be empty for pure insertion).\n' +
        '  - newLines: The lines to insert (can be empty for pure deletion).\n' +
        '  - contextAfter: 2-3 lines of code immediately below the edit point.\n\n' +
        'Matching is progressive: exact match first, then trailing whitespace ' +
        'normalization, then full whitespace normalization. The fuzz level is ' +
        'reported so you can see how cleanly the patch applied.\n\n' +
        'Example — replacing a function body:\n' +
        '  {\n' +
        '    "anchors": ["def example():"],\n' +
        '    "contextBefore": ["", "def example():", "    \\"""\\"""\\"Docstring\\"""\\"""\\""],\n' +
        '    "oldLines": ["    pass"],\n' +
        '    "newLines": ["    return 42"],\n' +
        '    "contextAfter": ["", "", ""]\n' +
        '  }\n\n' +
        'Example — adding a new method to a class:\n' +
        '  {\n' +
        '    "anchors": ["class Calculator:"],\n' +
        '    "contextBefore": ["    def subtract(self, a, b):", "        return a - b", ""],\n' +
        '    "oldLines": [],\n' +
        '    "newLines": ["    def multiply(self, a, b):", "        return a * b", ""],\n' +
        '    "contextAfter": ["    def divide(self, a, b):", "        return a / b"]\n' +
        '  }',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          hunks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                anchors: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Optional content anchor lines to locate the edit site. ' +
                    'Use multiple anchors for hierarchical disambiguation ' +
                    '(e.g., ["class Foo:", "    def bar():"]). ' +
                    'If omitted, the tool searches the whole file for the context.',
                },
                contextBefore: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Lines of code immediately above the edit point. ' +
                    'These are matched (with fuzzy fallback) to verify location. ' +
                    'Provide 2-3 lines for reliable anchoring.',
                },
                oldLines: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'The exact lines to remove at this location. ' +
                    'Empty array means pure insertion (no deletion).',
                },
                newLines: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'The lines to insert at this location. ' +
                    'Empty array means pure deletion (no insertion).',
                },
                contextAfter: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Lines of code immediately below the edit point. ' +
                    'These are matched (with fuzzy fallback) to verify location. ' +
                    'Provide 2-3 lines for reliable anchoring.',
                },
              },
              required: ['newLines'],
              additionalProperties: false,
            },
          },
          color: {
            type: 'boolean',
            description:
              'Enable ANSI color coding in output. Default: auto-detect from environment.',
          },
        },
        required: ['path', 'hunks'],
        additionalProperties: false,
      },
      execute: async input => {
        try {
          if (typeof input.path !== 'string' || input.path.trim().length === 0) {
            throw new Error('file__apply_diff requires a non-empty path string.');
          }
          if (!Array.isArray(input.hunks) || input.hunks.length === 0) {
            throw new Error('file__apply_diff requires a non-empty hunks array.');
          }

          const filePath = path.resolve(input.path.trim());
          let content: string;
          try {
            content = await readFile(filePath, 'utf-8');
          } catch (err) {
            throw enhanceFsError('file__apply_diff', filePath, err);
          }
          const lines = content.split('\n');

          // Parse hunks into PatchHunk format
          const patchHunks: PatchHunk[] = input.hunks
            .filter(isRecord)
            .map(hunk => ({
              anchors: Array.isArray(hunk.anchors)
                ? (hunk.anchors as string[])
                : [],
              contextBefore: Array.isArray(hunk.contextBefore)
                ? (hunk.contextBefore as string[])
                : [],
              oldLines: Array.isArray(hunk.oldLines)
                ? (hunk.oldLines as string[])
                : [],
              newLines: Array.isArray(hunk.newLines)
                ? (hunk.newLines as string[])
                : [],
              contextAfter: Array.isArray(hunk.contextAfter)
                ? (hunk.contextAfter as string[])
                : [],
            }));

          // Apply the patch (applies to a copy internally, returns patchedLines)
          const result = applyPatch(lines, patchHunks);

          if (!result.success) {
            // Build a detailed error message from all errors
            const errorMessages = result.errors
              .map(
                e =>
                  `Hunk ${e.hunkIndex}: ${e.message}\n  Detail: ${e.detail}`
              )
              .join('\n\n');
            throw new Error(
              `file__apply_diff: ${result.errors.length} hunk(s) failed to apply.\n\n${errorMessages}`
            );
          }

          // Build DiffHunkV2 array for rendering
          const diffHunks = patchHunks.map((hunk, i) => ({
            anchors: hunk.anchors,
            contextBefore: hunk.contextBefore,
            oldLines: hunk.oldLines,
            newLines: hunk.newLines,
            contextAfter: hunk.contextAfter,
            fuzz: result.appliedHunks[i]?.fuzz,
          }));

          // Always use plain text — the diff result goes to both the LLM (which
          // shouldn't see ANSI codes) and the TUI (which does its own coloring
          // in formatDiffOutput). The `color` input parameter is kept for schema
          // backward-compatibility but is effectively ignored.
          const diffResult = renderDiffV2(filePath, diffHunks, false);
          const diffOutput = diffResult.plain;

          // Write the patched content from applyPatch's internal working copy
          try {
            await writeFile(filePath, result.patchedLines.join('\n'), 'utf-8');
          } catch (err) {
            throw enhanceFsError('file__apply_diff', filePath, err);
          }

          return JSON.stringify(
            {
              path: filePath,
              patched: true,
              summary: diffResult.summary,
              diff: diffOutput,
            },
            null,
            2
          );
        } catch (err) {
          registration.logger.error(
            `file__apply_diff FAILED for path=${JSON.stringify(input.path)} ` +
            `hunks=${JSON.stringify(input.hunks)} ` +
            `color=${JSON.stringify(input.color)}`
          );
          throw err;
        }
      },
    });

    // -----------------------------------------------------------------------
    // file__glob
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'glob',
      description:
        'Find files matching a glob (e.g. **/*.ts). Uses **, *, ? patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern.' },
          cwd: {
            type: 'string',
            description: 'Working directory (default: cwd).',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: async input => {
        if (
          typeof input.pattern !== 'string' ||
          input.pattern.trim().length === 0
        ) {
          throw new Error('file__glob requires a non-empty pattern string.');
        }
        const cwd =
          typeof input.cwd === 'string' && input.cwd.trim().length > 0
            ? path.resolve(input.cwd.trim())
            : process.cwd();

        try {
          const cwdStat = await stat(cwd);
          if (!cwdStat.isDirectory()) {
            throw new Error(`file__glob: cwd is not a directory: ${cwd}.`);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('file__glob')) {
            throw err;
          }
          throw enhanceFsError('file__glob', cwd, err);
        }

        const pattern = input.pattern.trim();
        const matches = await fg(pattern, { cwd, absolute: true });
        return JSON.stringify({ pattern, cwd, matches }, null, 2);
      },
    });
  },
};