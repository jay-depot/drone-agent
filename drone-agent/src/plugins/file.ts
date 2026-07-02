import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { DronePlugin } from 'drone-core';
import { renderDiffV2 } from '../shared/diff-renderer.js';
import {
  applyPatch,
  type PatchHunk,
  type PatchError,
} from '../shared/patch-applier.js';
import { parseUnifiedDiff } from '../shared/unified-diff-parser.js';

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

/**
 * Format a PatchError into a concise, LLM-friendly error message that speaks
 * in unified-diff terms ("- lines", "context lines", "@@ header") rather than
 * internal data structure names.
 */
function formatPatchError(e: PatchError): string {
  const tag = `Hunk ${e.hunkIndex}:`;

  if (e.message.startsWith('Anchor not found')) {
    const heading = e.anchors[0] || '(no anchor)';
    return (
      `${tag} The @@ section heading "${heading}" was not found in the file.\n` +
      `  Detail: The heading was not found at any fuzz level. ` +
      `Try removing the heading from the @@ line, or re-read the file with file__read to find the correct section.`
    );
  }

  if (e.message.startsWith('Anchor chain not found')) {
    return (
      `${tag} The @@ section heading chain "${e.anchors.join(' > ')}" could not be matched.\n` +
      `  Detail: The first heading "${e.anchors[0]}" exists, but subsequent headings don't follow it.`
    );
  }

  if (e.message.includes('Context does not match')) {
    const expectedOld = JSON.stringify(e.foundOldLines ?? []);
    const fileOld = e.foundOldLines
      ? JSON.stringify(e.anchors?.length ? e.foundOldLines : [])
      : '(unknown)';
    const atLine =
      e.anchors.length > 0
        ? `near the @@ heading "${e.anchors[0]}"`
        : 'at the anchor location';
    return (
      `${tag} The \`-\` lines didn't match what's in the file ${atLine}.\n` +
      `  Your patch shows: ${expectedOld}\n` +
      `  The file has:     ${fileOld}\n` +
      `  Re-read the file with file__read to confirm the contents, then correct the \`-\` lines.`
    );
  }

  if (e.message.includes('Context not found anywhere')) {
    return (
      `${tag} The context lines around the change couldn't be matched anywhere in the file.\n` +
      `  The patch expects these \`-\` lines: ${JSON.stringify(e.foundOldLines ?? [])}\n` +
      `  Re-read the file with file__read to see the current content, then adjust the context lines in the patch.`
    );
  }

  // Fallback
  return `${tag} ${e.message}\n  Detail: ${e.detail}`;
}

export const filePlugin: DronePlugin = {
  metadata: {
    id: 'file',
    name: 'File',
    version: '0.3.0',
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
        'Apply a unified diff patch to a file. ' +
        'Accepts a patch string in `git diff` format, e.g.:\n\n' +
        '@@ -5,7 +5,7 @@ function_name():\n' +
        '     context\n' +
        '     context\n' +
        '-    removed line\n' +
        '+    added line\n' +
        '     context\n\n' +
        'Hunks start with @@ -start,count +start,count @@ [section heading].\n' +
        'Lines with ` ` are context, `-` are removed, `+` are added.\n' +
        'Multiple hunks (multiple @@ sections) are applied bottom-up.\n\n' +
        'Line numbers and section headings are soft hints — content-anchored\n' +
        'matching is used for accuracy. The patch is robust to small file changes.\n\n' +
        'Tips:\n' +
        '  - Use `file__read` first to check the current file content.\n' +
        '  - Include 2-3 lines of context around each change.\n' +
        '  - Whitespace differences are handled via progressive fuzzy matching.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to modify.',
          },
          patch: {
            type: 'string',
            description:
              'Unified diff patch string in `git diff` format. ' +
              'Each hunk starts with @@ -start,count +start,count @@ [section heading].\n' +
              'Lines prefixed with ` ` are context, `-` are removed, `+` are added.\n' +
              'Example: @@ -10,4 +10,4 @@ function_name:\n' +
              '   context\n' +
              '  -old line\n' +
              '  +new line\n' +
              '   context',
          },
        },
        required: ['path', 'patch'],
        additionalProperties: false,
      },
      execute: async input => {
        try {
          if (
            typeof input.path !== 'string' ||
            input.path.trim().length === 0
          ) {
            throw new Error(
              'file__apply_diff requires a non-empty path string.'
            );
          }
          if (
            typeof input.patch !== 'string' ||
            input.patch.trim().length === 0
          ) {
            throw new Error(
              'file__apply_diff requires a non-empty patch string in unified diff format.'
            );
          }

          const filePath = path.resolve(input.path.trim());
          let content: string;
          try {
            content = await readFile(filePath, 'utf-8');
          } catch (err) {
            throw enhanceFsError('file__apply_diff', filePath, err);
          }
          const lines = content.split('\n');

          // Parse unified diff string into our internal hunk format
          const hunks = parseUnifiedDiff(input.patch);

          if (hunks.length === 0) {
            throw new Error(
              'file__apply_diff: no hunks found in the patch string.\n\n' +
                'The patch did not contain any @@ ... @@ hunk headers. ' +
                'Make sure the patch uses unified diff format, e.g.:\n' +
                '@@ -5,7 +5,7 @@ function_name():\n' +
                '     context\n' +
                '-    old line\n' +
                '+    new line\n\n' +
                'Re-read the file with file__read to confirm the current contents, then try again.'
            );
          }

          // Apply the patch (applies to a copy internally, returns patchedLines)
          const result = applyPatch(lines, hunks);

          if (!result.success) {
            // Concise error messages in unified-diff language
            const errorMessages = result.errors
              .map(formatPatchError)
              .join('\n\n');
            throw new Error(
              `file__apply_diff: ${result.errors.length} of ${hunks.length} hunk(s) failed to apply.\n\n${errorMessages}\n\n` +
                `Tip: Re-read the file with file__read to confirm the current contents, then correct the patch and try again. No changes were written.`
            );
          }

          // Build DiffHunkV2 array for rendering
          const diffHunks = hunks.map((hunk, i) => ({
            anchors: hunk.anchors,
            contextBefore: hunk.contextBefore,
            oldLines: hunk.oldLines,
            newLines: hunk.newLines,
            contextAfter: hunk.contextAfter,
            fuzz: result.appliedHunks[i]?.fuzz,
          }));

          // Always use plain text — the diff result goes to both the LLM (which
          // shouldn't see ANSI codes) and the TUI (which does its own coloring
          // in formatDiffOutput).
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
              `patch=${JSON.stringify(typeof input.patch === 'string' ? input.patch.slice(0, 200) : '')}`
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
