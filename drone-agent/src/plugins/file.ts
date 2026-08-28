import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { DronePlugin, DroneToolDefinition } from 'drone-core';
import { FileReadBlock } from '../tui/components/FileReadBlock.js';
import { FileWriteBlock } from '../tui/components/FileWriteBlock.js';
import { FileApplyDiffBlock } from '../tui/components/FileApplyDiffBlock.js';
import { FileListBlock } from '../tui/components/FileListBlock.js';
import { FileGlobBlock } from '../tui/components/FileGlobBlock.js';
import { renderDiffV2 } from '../shared/diff-renderer.js';
import { applyPatch, type PatchError } from '../shared/patch-applier.js';
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
 * Format a PatchError into an LLM-friendly error message. Each failure type
 * is reported differently:
 *
 *   Type 1 (multiple matches): a cheat sheet listing each match with line
 *     numbers + surrounding context, plus a reworked hunk that would uniquely
 *     target each one (the LLM can crib and resubmit).
 *   Type 2 (old code not found): up to 5 Levenshtein-closest file spans with
 *     location + actual content; or a plain "not found" message if the old
 *     code is too generic.
 *   Type 3 (narrowing over-eliminated): unrolled to the last multiple-match
 *     step, then reported like Type 1.
 */
function formatPatchError(e: PatchError): string {
  const tag = `Hunk ${e.hunkIndex}:`;

  if (e.failureType === 'type2') {
    const suggestions = e.suggestions ?? [];
    if (suggestions.length === 0) {
      return (
        `${tag} The old code (the \`-\` lines) was not found in the file in any form.\n` +
        `  ${e.detail}`
      );
    }
    const lines = suggestions.map(
      s =>
        `  - line ${s.line} (distance ${s.distance}):\n` +
        s.content
          .split('\n')
          .map(l => `      ${l}`)
          .join('\n')
    );
    return (
      `${tag} The old code (the \`-\` lines) was not found in the file.\n` +
      `  ${e.detail}\n` +
      `  Closest candidates:\n${lines.join('\n')}`
    );
  }

  // Type 1 and Type 3 share the cheat-sheet format.
  const sites = e.matchSites ?? [];
  const siteBlocks = sites.map((site, idx) => {
    const ctx = site.context.map(l => `    ${l}`).join('\n');
    return (
      `  Match ${idx + 1} (line ${site.line}):\n` +
      `${ctx}\n` +
      `  Reworked hunk to target this match:\n` +
      '  ```diff\n' +
      site.reworkedHunk
        .split('\n')
        .map(l => `  ${l}`)
        .join('\n') +
      '\n  ```'
    );
  });
  return `${tag} ${e.message}\n  ${e.detail}\n\n${siteBlocks.join('\n\n')}`;
}

export const filePlugin: DronePlugin = {
  metadata: {
    id: 'file',
    name: 'File',
    version: '0.4.0',
    description: 'Read, write, list, and patch files in the workspace.',
    defaultEnabled: false,
  },
  register: async registration => {
    registration.registerPromptFragment({
      key: 'editing-convention',
      phase: 'header',
      render: async () =>
        `# File Editing\n\n**Guideline:** When modifying existing files, use \`apply_diff\` to ensure precision and prevent data loss. Use \`write\` only for creating new files or performing complete rewrites. If \`apply_diff\` is not available when you need to edit, mount it via \`runtime__mount_tool({ "tool": "file__apply_diff" })\`.`,
    });

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
      renderComponent: state => FileReadBlock({ state }),
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
      renderComponent: state => FileListBlock({ state }),
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
      renderComponent: state => FileWriteBlock({ state }),
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

        // Verify the write by reading back and comparing.
        let verified = true;
        let verificationError: string | undefined;
        try {
          const written = await readFile(filePath, 'utf-8');
          if (written !== input.content) {
            verified = false;
            verificationError = `Content mismatch: wrote ${input.content.length} bytes but read back ${written.length} bytes`;
          }
        } catch (err) {
          verified = false;
          verificationError = `Could not verify: ${err instanceof Error ? err.message : String(err)}`;
        }

        return JSON.stringify(
          { path: filePath, written: true, verified, verificationError },
          null,
          2
        );
      },
    });

    // -----------------------------------------------------------------------
    // file__apply_diff
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'apply_diff',
      description:
        'Apply a unified diff patch to a file. ' +
        'Accepts a patch string in `git/unified diff` format, e.g.:\n\n' +
        '```diff\n' +
        '@@ -5,7 +5,7 @@ function_name():\n' +
        '     context\n' +
        '     context\n' +
        '-    removed line\n' +
        '+    added line\n' +
        '     context\n\n' +
        '```\n' +
        'Hunks start with @@ -start,count +start,count @@ [section heading].\n' +
        'Lines with ` ` are context, `-` are removed, `+` are added.\n' +
        'Multiple hunks (multiple @@ sections) are applied top-to-bottom.\n\n' +
        'Matching is content-anchored and robust to formatting changes:\n' +
        '  1. The `-` lines (old change zone) are searched for in the file.\n' +
        '  2. If multiple matches, surrounding context lines narrow them down.\n' +
        '  3. If still ambiguous, the @@ section heading narrows further.\n' +
        'Aggressive format-aware fuzz (collapse all whitespace including\n' +
        'newlines) handles auto-formatter reflow (prettier/eslint --fix).\n\n' +
        'Partial success is supported: successful hunks are applied and the\n' +
        'file is written; failed hunks are reported but do not block others.\n' +
        'On failure the error includes a cheat sheet with reworked hunks you\n' +
        'can crib and resubmit, or the closest file spans for not-found code.\n\n' +
        'Tips:\n' +
        '  - Use `file__read` first to check the current file content.\n' +
        '  - Include 2-3 lines of context around each change.\n' +
        '  - Interleaved context lines inside the change zone are preserved.',
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
              'Context lines between `-`/`+` lines are preserved (standard unified-diff semantics).\n' +
              'Example:\n' +
              '```diff\n' +
              '@@ -10,4 +10,4 @@ function_name:\n' +
              '   context\n' +
              '  -old line\n' +
              '  +new line\n' +
              '   context\n' +
              '```',
          },
        },
        required: ['path', 'patch'],
        additionalProperties: false,
      },
      renderComponent: state => FileApplyDiffBlock({ state }),
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file__apply_diff requires a non-empty path string.');
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

        // Build DiffHunkV2 array for rendering (only applied hunks).
        // Each AppliedHunk carries its original hunkIndex so we can correlate.
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

        // Always use plain text — the diff result goes to both the LLM (which
        // shouldn't see ANSI codes) and the TUI (which does its own coloring
        // in formatDiffOutput).
        const diffResult = renderDiffV2(filePath, diffHunks, false);
        const diffOutput = diffResult.plain;

        // Partial success: write the file if at least one hunk succeeded.
        // If zero hunks succeeded, do not write (nothing changed).
        const anyApplied = result.appliedHunks.length > 0;
        if (anyApplied) {
          try {
            await writeFile(filePath, result.patchedLines.join('\n'), 'utf-8');
          } catch (err) {
            throw enhanceFsError('file__apply_diff', filePath, err);
          }
        }

        if (!result.success) {
          const errorMessages = result.errors
            .map(formatPatchError)
            .join('\n\n');
          const writeNote = anyApplied
            ? `The file was written with the ${result.appliedHunks.length} successful hunk(s) applied. The failed hunk(s) were not applied.`
            : `No changes were written.`;
          throw new Error(
            `file__apply_diff: ${result.errors.length} of ${hunks.length} hunk(s) failed to apply.\n` +
              `${writeNote}\n\n${errorMessages}\n\n` +
              `Tip: Re-read the file with file__read to confirm the current contents, then correct the patch and try again.`
          );
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
      renderComponent: state => FileGlobBlock({ state }),
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

    // -----------------------------------------------------------------------
    // file__read_image
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'read_image',
      description:
        'Read an image file and return its base64-encoded data. ' +
        'Supported formats: JPEG, PNG, WebP, GIF. ' +
        'The image data will be injected into the conversation for vision-capable models.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the image file.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.path !== 'string' || input.path.trim().length === 0) {
          throw new Error('file__read_image requires a non-empty path string.');
        }
        const filePath = path.resolve(input.path.trim());

        const ext = path.extname(filePath).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
        };
        const mimeType = mimeMap[ext];
        if (!mimeType) {
          throw new Error(
            `file__read_image: unsupported image format "${ext}". Supported formats: .jpg, .jpeg, .png, .webp, .gif`
          );
        }

        let buffer: Buffer;
        try {
          buffer = await readFile(filePath);
        } catch (err) {
          throw enhanceFsError('file__read_image', filePath, err);
        }

        const maxSize =
          registration.getConfig().session.maxImageSizeBytes ??
          20 * 1024 * 1024;
        if (buffer.length > maxSize) {
          throw new Error(
            `file__read_image: image size (${buffer.length} bytes) exceeds the maximum allowed size (${maxSize} bytes).`
          );
        }

        const data = buffer.toString('base64');
        return JSON.stringify(
          { path: filePath, mimeType, data, size: buffer.length },
          null,
          2
        );
      },
    });
  },
};
