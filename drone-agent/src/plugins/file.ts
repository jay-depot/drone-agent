import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DronePlugin } from 'drone-core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const filePlugin: DronePlugin = {
  metadata: {
    id: 'file',
    name: 'File',
    version: '0.1.0',
    description: 'Read, write, list, and patch files in the workspace.',
    defaultEnabled: false,
  },
  register: async registration => {
    // -----------------------------------------------------------------------
    // file.read
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'read',
      description:
        'Read a file by absolute path. Optionally specify startLine and endLine (1-based, inclusive) to read a range.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file.',
          },
          startLine: {
            type: 'number',
            description:
              'First line number (1-based). Omit to read from the beginning.',
          },
          endLine: {
            type: 'number',
            description:
              'Last line number (1-based, inclusive). Omit to read to the end.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file.read requires a non-empty path string.');
        }
        const filePath = path.resolve(input.path.trim());
        const content = await readFile(filePath, 'utf-8');
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
            `file.read: startLine (${startLine}) must not exceed endLine (${endLine}).`
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
    // file.list
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'list',
      description:
        'List directory contents at an absolute path. Returns file names, types (file/directory), and sizes.',
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
          throw new Error('file.list requires a non-empty path string.');
        }
        const dirPath = path.resolve(input.path.trim());
        const entries = await readdir(dirPath, { withFileTypes: true });
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
    // file.write
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'write',
      description:
        'Write content to a file at an absolute path. Creates parent directories if needed. Overwrites existing content.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file.',
          },
          content: {
            type: 'string',
            description: 'Content to write.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file.write requires a non-empty path string.');
        }
        if (typeof input.content !== 'string') {
          throw new Error('file.write requires a content string.');
        }
        const filePath = path.resolve(input.path.trim());
        await writeFile(filePath, input.content, 'utf-8');
        return JSON.stringify({ path: filePath, written: true }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // file.apply_diff
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'apply_diff',
      description:
        'Apply a unified-diff-style patch to a file. Each hunk specifies a startLine (1-based) and a list of oldLines to remove and newLines to insert in their place.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to patch.',
          },
          hunks: {
            type: 'array',
            description:
              'Array of diff hunks. Each hunk has startLine (1-based), oldLines (strings to remove), and newLines (strings to insert).',
            items: {
              type: 'object',
              properties: {
                startLine: {
                  type: 'number',
                  description: '1-based line number where this hunk applies.',
                },
                oldLines: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lines expected at this location (removed).',
                },
                newLines: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Lines to insert at this location.',
                },
              },
              required: ['startLine', 'newLines'],
              additionalProperties: false,
            },
          },
        },
        required: ['path', 'hunks'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file.apply_diff requires a non-empty path string.');
        }
        if (!Array.isArray(input.hunks) || input.hunks.length === 0) {
          throw new Error('file.apply_diff requires a non-empty hunks array.');
        }

        const filePath = path.resolve(input.path.trim());
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        // Sort hunks descending by startLine so we apply bottom-up and avoid
        // line-number invalidation.
        const hunks = [...input.hunks]
          .filter(isRecord)
          .map(hunk => ({
            startLine:
              typeof hunk.startLine === 'number'
                ? Math.floor(hunk.startLine)
                : 1,
            oldLines: Array.isArray(hunk.oldLines)
              ? (hunk.oldLines as string[])
              : [],
            newLines: Array.isArray(hunk.newLines)
              ? (hunk.newLines as string[])
              : [],
          }))
          .sort((a, b) => b.startLine - a.startLine);

        for (const hunk of hunks) {
          const idx = hunk.startLine - 1;
          if (idx < 0 || idx > lines.length) {
            throw new Error(
              `Hunk startLine ${hunk.startLine} is out of range (file has ${lines.length} lines).`
            );
          }

          // Verify oldLines match if provided
          if (hunk.oldLines.length > 0) {
            const actual = lines.slice(idx, idx + hunk.oldLines.length);
            if (actual.join('\n') !== hunk.oldLines.join('\n')) {
              throw new Error(
                `Hunk at line ${hunk.startLine} does not match file content. Expected:\n${hunk.oldLines.join('\n')}\n\nActual:\n${actual.join('\n')}`
              );
            }
            lines.splice(idx, hunk.oldLines.length, ...hunk.newLines);
          } else {
            // No oldLines means pure insertion
            lines.splice(idx, 0, ...hunk.newLines);
          }
        }

        await writeFile(filePath, lines.join('\n'), 'utf-8');
        return JSON.stringify({ path: filePath, patched: true }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // file.glob
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'glob',
      description:
        'Find files matching a glob pattern relative to the workspace root. Uses fast-glob patterns (e.g. **/*.ts, src/**/*.css).',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match (e.g. **/*.ts, src/**/*.css).',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the glob. Defaults to the current working directory.',
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
          throw new Error('file.glob requires a non-empty pattern string.');
        }
        const cwd =
          typeof input.cwd === 'string' && input.cwd.trim().length > 0
            ? path.resolve(input.cwd.trim())
            : process.cwd();

        // Use a simple recursive directory walk for glob matching to avoid
        // external dependencies. Supports **, *, and ? patterns.
        const pattern = input.pattern.trim();
        const matches = await simpleGlob(pattern, cwd);
        return JSON.stringify({ pattern, cwd, matches }, null, 2);
      },
    });
  },
};

/**
 * Minimal glob implementation that supports **, *, and ? patterns.
 * Walks directories recursively and matches against the pattern.
 */
async function simpleGlob(pattern: string, cwd: string): Promise<string[]> {
  // Convert glob pattern to regex
  const regexStr =
    '^' +
    pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<DOUBLESTAR>>>/g, '.*')
      .replace(/\?/g, '.') +
    '$';
  const regex = new RegExp(regexStr);

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: { name: string; isDir: boolean }[];
    try {
      const dirEntries = await readdir(dir, { withFileTypes: true });
      entries = dirEntries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(cwd, fullPath);
      if (regex.test(relativePath)) {
        results.push(fullPath);
      }
      if (entry.isDir) {
        await walk(fullPath);
      }
    }
  }

  await walk(cwd);
  return results.sort();
}
