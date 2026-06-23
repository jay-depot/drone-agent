import { isRecord } from '../shared/type-guards.js';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { DronePlugin } from 'drone-core';

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
        `${toolName}: expected a file but ${targetPath} is a directory. Use file.list for directories.`
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
      description: 'Read a file (absolute path). Optional 1-based startLine/endLine.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          startLine: { type: 'number', description: 'First line (1-based).' },
          endLine: { type: 'number', description: 'Last line (1-based, inclusive).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file.read requires a non-empty path string.');
        }
        const filePath = path.resolve(input.path.trim());
        let content: string;
        try {
          content = await readFile(filePath, 'utf-8');
        } catch (err) {
          throw enhanceFsError('file.read', filePath, err);
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
      description: 'List a directory (absolute path). Returns names, types, sizes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file.list requires a non-empty path string.');
        }
        const dirPath = path.resolve(input.path.trim());
        let entries: import('node:fs').Dirent[];
        try {
          entries = await readdir(dirPath, { withFileTypes: true });
        } catch (err) {
          throw enhanceFsError('file.list', dirPath, err);
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
    // file.write
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'write',
      description: 'Write content to a file (absolute path). Creates parents; overwrites.',
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
          throw new Error('file.write requires a non-empty path string.');
        }
        if (typeof input.content !== 'string') {
          throw new Error('file.write requires a content string.');
        }
        const filePath = path.resolve(input.path.trim());
        try {
          await writeFile(filePath, input.content, 'utf-8');
        } catch (err) {
          throw enhanceFsError('file.write', filePath, err);
        }
        return JSON.stringify({ path: filePath, written: true }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // file.apply_diff
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'apply_diff',
      description: 'Apply hunks to a file. Each hunk has startLine, optional oldLines (for verification), and newLines (to insert).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          hunks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                startLine: { type: 'number', description: '1-based line number.' },
                oldLines: { type: 'array', items: { type: 'string' }, description: 'Lines expected at this location (verified, then removed).' },
                newLines: { type: 'array', items: { type: 'string' }, description: 'Lines to insert.' },
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
        let content: string;
        try {
          content = await readFile(filePath, 'utf-8');
        } catch (err) {
          throw enhanceFsError('file.apply_diff', filePath, err);
        }
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

        try {
          await writeFile(filePath, lines.join('\n'), 'utf-8');
        } catch (err) {
          throw enhanceFsError('file.apply_diff', filePath, err);
        }
        return JSON.stringify({ path: filePath, patched: true }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // file.glob
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'glob',
      description: 'Find files matching a glob (e.g. **/*.ts). Uses **, *, ? patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern.' },
          cwd: { type: 'string', description: 'Working directory (default: cwd).' },
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

        try {
          const cwdStat = await stat(cwd);
          if (!cwdStat.isDirectory()) {
            throw new Error(
              `file.glob: cwd is not a directory: ${cwd}.`
            );
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('file.glob')) {
            throw err;
          }
          throw enhanceFsError('file.glob', cwd, err);
        }

        const pattern = input.pattern.trim();
        const matches = await fg(pattern, { cwd, absolute: true });
        return JSON.stringify({ pattern, cwd, matches }, null, 2);
      },
    });
  },
};
