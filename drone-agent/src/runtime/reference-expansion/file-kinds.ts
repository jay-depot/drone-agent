// ── `file:` reference kind ──────────────────────────────────────────
//
// Resolves `@<path>` references: files are inlined as a fenced block,
// directories as a recursive name-only listing, and globs as the matching
// files. Paths default to the CWD, with `~/` expanding to the home directory.
// Binary files are skipped, and content is bounded per-file (lines + bytes)
// and across the whole message by a shared budget.

import { open, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type {
  DroneReferenceContext,
  DroneReferenceResolution,
} from 'drone-core';

export const MAX_LINES = 2000;
export const MAX_BYTES = 256 * 1024;
export const MAX_DIR_ENTRIES = 500;
export const MAX_GLOB_MATCHES = 30;
const BINARY_SNIFF_BYTES = 8000;

export type ExpansionBudget = { used: number; limit: number };

const LANG_HINTS: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.json': 'json',
  '.md': 'md',
  '.py': 'py',
  '.rs': 'rs',
  '.go': 'go',
  '.sh': 'sh',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.html': 'html',
  '.sql': 'sql',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.java': 'java',
  '.rb': 'rb',
  '.php': 'php',
  '.xml': 'xml',
};

/** A backtick fence longer than any run inside the content. */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** A trailing newline does not start a new line (editor convention). */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.split('\n').length;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function langHint(filePath: string): string {
  return LANG_HINTS[path.extname(filePath).toLowerCase()] ?? '';
}

/** Expand a leading `~`/`~/` to the home directory; resolve the rest against CWD. */
export function resolveReferencePath(
  value: string,
  ctx: DroneReferenceContext
): string {
  if (value === '~') {
    return ctx.homedir;
  }
  if (value.startsWith('~/')) {
    return path.resolve(ctx.homedir, value.slice(2));
  }
  return path.resolve(ctx.cwd, value);
}

async function dedupKeyFor(absPath: string): Promise<string> {
  try {
    return await realpath(absPath);
  } catch {
    return path.resolve(absPath);
  }
}

/** Read at most `maxBytes` from a file, reporting whether it was longer. */
async function readBounded(
  absPath: string,
  maxBytes: number
): Promise<{ buf: Buffer; truncated: boolean }> {
  const handle = await open(absPath, 'r');
  try {
    const { size } = await handle.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await handle.read(buf, off, len - off, off);
      if (bytesRead === 0) {
        break;
      }
      off += bytesRead;
    }
    return { buf: buf.subarray(0, off), truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}

/** Internal resolution plus the content metrics needed to aggregate glob receipts. */
type BuiltFileBlock = DroneReferenceResolution & {
  bytes: number;
  lines: number;
};

async function buildFileBlock(
  displayPath: string,
  absPath: string,
  budget: ExpansionBudget
): Promise<BuiltFileBlock> {
  if (budget.used >= budget.limit) {
    return {
      block: '',
      images: [],
      notice: `[expansion budget exceeded; @${displayPath} not included]`,
      bytes: 0,
      lines: 0,
    };
  }

  const remaining = budget.limit - budget.used;
  const read = await readBounded(absPath, Math.min(MAX_BYTES, remaining));
  const buf = read.buf;
  let truncated = read.truncated;

  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return {
      block: '',
      images: [],
      notice: `[skipped binary: @${displayPath}]`,
      bytes: 0,
      lines: 0,
    };
  }

  let text = buf.toString('utf-8');
  const lines = text.split('\n');
  if (lines.length > MAX_LINES) {
    text = lines.slice(0, MAX_LINES).join('\n');
    truncated = true;
  }

  budget.used += Buffer.byteLength(text);

  const fence = fenceFor(text);
  let block = `${fence}${langHint(absPath)}\n${text}\n${fence}`;
  if (truncated) {
    block += '\n[… truncated]';
  }
  const bytes = Buffer.byteLength(text);
  const contentLines = countLines(text);
  return {
    block,
    images: [],
    dedupKey: await dedupKeyFor(absPath),
    notice: `[expanded @${displayPath} (${contentLines} lines, ${formatBytes(bytes)})]`,
    bytes,
    lines: contentLines,
  };
}

async function globMatches(
  value: string,
  ctx: DroneReferenceContext
): Promise<string[]> {
  let cwd = ctx.cwd;
  let pattern = value;
  if (value.startsWith('~/')) {
    cwd = ctx.homedir;
    pattern = value.slice(2);
  } else if (value === '~') {
    cwd = ctx.homedir;
    pattern = '*';
  }
  try {
    const matches = await fg(pattern, {
      cwd,
      absolute: true,
      onlyFiles: true,
      dot: false,
    });
    return matches.sort();
  } catch {
    return [];
  }
}

async function resolveGlob(
  value: string,
  ctx: DroneReferenceContext,
  budget: ExpansionBudget
): Promise<DroneReferenceResolution> {
  const all = await globMatches(value, ctx);
  if (all.length === 0) {
    return {
      block: '',
      images: [],
      notice: `[unresolved reference: @${value}]`,
    };
  }
  const shown = all.slice(0, MAX_GLOB_MATCHES);
  const parts: string[] = [];
  let included = 0;
  let skipped = 0;
  let bytes = 0;
  for (const abs of shown) {
    const display = path.relative(ctx.cwd, abs) || abs;
    const res = await buildFileBlock(display, abs, budget);
    if (res.block) {
      parts.push(`**${display}**\n${res.block}`);
      included += 1;
      bytes += res.bytes;
    } else {
      skipped += 1;
    }
  }
  let block = parts.join('\n\n');
  if (all.length > MAX_GLOB_MATCHES) {
    block += `\n\n[… matched ${all.length}, showing ${MAX_GLOB_MATCHES}]`;
  }
  let notice: string | undefined;
  if (included > 0) {
    const fileWord = included === 1 ? 'file' : 'files';
    const skipSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
    notice = `[expanded @${value} (${included} ${fileWord}, ${formatBytes(bytes)}${skipSuffix})]`;
  }
  return { block, images: [], dedupKey: `glob:${value}`, notice };
}

async function resolveDirectory(
  absPath: string
): Promise<DroneReferenceResolution> {
  const names: string[] = [];
  let truncated = false;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (names.length >= MAX_DIR_ENTRIES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (names.length >= MAX_DIR_ENTRIES) {
        truncated = true;
        return;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        names.push(`${rel}/`);
        await walk(path.join(dir, entry.name), rel);
      } else {
        names.push(rel);
      }
    }
  };

  await walk(absPath, '');

  const fence = fenceFor(names.join('\n'));
  let block = `${fence}\n${names.join('\n')}\n${fence}`;
  if (truncated) {
    block += `\n[… truncated at ${MAX_DIR_ENTRIES} entries]`;
  }
  return { block, images: [], dedupKey: await dedupKeyFor(absPath) };
}

export async function resolveFileReference(
  value: string,
  ctx: DroneReferenceContext,
  budget: ExpansionBudget
): Promise<DroneReferenceResolution> {
  if (value === '') {
    return { block: '', images: [] };
  }

  if (value.includes('*') || value.includes('?')) {
    return resolveGlob(value, ctx, budget);
  }

  const absPath = resolveReferencePath(value, ctx);

  let stats;
  try {
    stats = await stat(absPath);
  } catch {
    return {
      block: '',
      images: [],
      notice: `[unresolved reference: @${value}]`,
    };
  }

  if (stats.isDirectory()) {
    return resolveDirectory(absPath);
  }

  try {
    return await buildFileBlock(value, absPath, budget);
  } catch {
    return {
      block: '',
      images: [],
      notice: `[unresolved reference: @${value}]`,
    };
  }
}
