// ── Tab-completion (pure helpers) ───────────────────────────────────
//
// Context detection, candidate listing, and accept/replace logic for the
// TUI's input-line completion menu. Pure/async functions with no React
// dependency, so they are unit-testable in isolation. The `useCompletion`
// hook and `CompletionMenu` component build on these.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  DroneReferenceContext,
  DroneSkillsCapability,
  DroneSlashCommand,
} from 'drone-core';

/** The engine slice needed to list slash-command completions. */
export type SlashCommandSource = {
  getSlashCommands: () => DroneSlashCommand[];
};

export type CompletionItem = {
  id: string;
  display: string;
  apply: string;
  hint?: string;
  reopen?: boolean;
};

export type CompletionContext =
  | { kind: 'none' }
  | { kind: 'slash'; tokenStart: number; prefix: string }
  | { kind: 'skill'; tokenStart: number; prefix: string }
  | { kind: 'file'; tokenStart: number; prefix: string };

const MAX_CANDIDATES = 50;

/** Detect what the caret is completing, from the text before the caret. */
export function detectCompletionContext(
  value: string,
  caret: number
): CompletionContext {
  const before = value.slice(0, caret);

  // Slash commands: a leading `/` at the very start with no whitespace after.
  const slashMatch = /^\/(\S*)$/.exec(before);
  if (slashMatch) {
    return { kind: 'slash', tokenStart: 0, prefix: slashMatch[1] };
  }

  // Otherwise, the current whitespace-delimited token.
  const tokenMatch = /(^|\s)(\S*)$/.exec(before);
  if (!tokenMatch) {
    return { kind: 'none' };
  }
  const token = tokenMatch[2];
  const tokenStart = before.length - token.length;
  if (!token.startsWith('@')) {
    return { kind: 'none' };
  }

  if (token.startsWith('@skill:')) {
    return { kind: 'skill', tokenStart, prefix: token.slice('@skill:'.length) };
  }
  return { kind: 'file', tokenStart, prefix: token.slice(1) };
}

/** Replace the active token with the selected item; returns the new value + caret. */
export function applyCompletion(
  value: string,
  caret: number,
  ctx: CompletionContext,
  item: CompletionItem
): { value: string; caret: number } {
  if (ctx.kind === 'none') {
    return { value, caret };
  }
  // The token extends from ctx.tokenStart to the caret (the user has not typed
  // past the caret). Splice the replacement in.
  const next = value.slice(0, ctx.tokenStart) + item.apply + value.slice(caret);
  return { value: next, caret: ctx.tokenStart + item.apply.length };
}

function resolveDirFromPrefix(
  prefix: string,
  ctx: DroneReferenceContext
): { dir: string; namePrefix: string; parentDisplay: string } {
  const lastSlash = prefix.lastIndexOf('/');
  if (lastSlash === -1) {
    return { dir: ctx.cwd, namePrefix: prefix, parentDisplay: '' };
  }
  const parent = prefix.slice(0, lastSlash + 1); // includes trailing slash
  const namePrefix = prefix.slice(lastSlash + 1);
  let dir: string;
  if (parent === '/') {
    dir = '/';
  } else if (parent === '~/') {
    dir = ctx.homedir;
  } else if (parent.startsWith('~/')) {
    dir = path.resolve(ctx.homedir, parent.slice(2));
  } else if (parent.startsWith('/')) {
    dir = parent;
  } else {
    dir = path.resolve(ctx.cwd, parent);
  }
  return { dir, namePrefix, parentDisplay: parent };
}

/** List file/directory candidates for a file-context prefix. */
export async function listFileCandidates(
  prefix: string,
  ctx: DroneReferenceContext
): Promise<CompletionItem[]> {
  const { dir, namePrefix, parentDisplay } = resolveDirFromPrefix(prefix, ctx);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const showHidden = namePrefix.startsWith('.');
  const lower = namePrefix.toLowerCase();
  const dirs: CompletionItem[] = [];
  const files: CompletionItem[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!showHidden && name.startsWith('.')) {
      continue;
    }
    if (!name.toLowerCase().startsWith(lower)) {
      continue;
    }
    const isDir = entry.isDirectory();
    const item: CompletionItem = {
      id: `${parentDisplay}${name}`,
      display: `${name}${isDir ? '/' : ''}`,
      apply: `@${parentDisplay}${name}${isDir ? '/' : ' '}`,
      reopen: isDir,
    };
    (isDir ? dirs : files).push(item);
  }

  dirs.sort((a, b) => a.display.localeCompare(b.display));
  files.sort((a, b) => a.display.localeCompare(b.display));
  return [...dirs, ...files].slice(0, MAX_CANDIDATES);
}

/** List slash-command candidates for a slash-context prefix. */
export function listSlashCandidates(
  prefix: string,
  engine: SlashCommandSource
): CompletionItem[] {
  const lower = prefix.toLowerCase();
  return engine
    .getSlashCommands()
    .filter(cmd => cmd.command.slice(1).toLowerCase().startsWith(lower))
    .sort((a, b) => a.command.localeCompare(b.command))
    .slice(0, MAX_CANDIDATES)
    .map(cmd => ({
      id: cmd.command,
      display: cmd.command,
      apply: `${cmd.command} `,
      hint: cmd.description,
    }));
}

/** List skill candidates for a `@skill:` prefix. */
export function listSkillCandidates(
  prefix: string,
  skills: DroneSkillsCapability | undefined
): CompletionItem[] {
  if (!skills) {
    return [];
  }
  const lower = prefix.toLowerCase();
  return skills
    .getSkills()
    .filter(s => s.id.toLowerCase().startsWith(lower))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_CANDIDATES)
    .map(s => ({
      id: s.id,
      display: s.id,
      apply: `@skill:${s.id} `,
      hint: s.description,
    }));
}
