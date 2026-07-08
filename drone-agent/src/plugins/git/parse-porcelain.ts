/**
 * Pure parser for `git status --porcelain=v1` output.
 *
 * The porcelain format uses TWO leading columns:
 *   - column 0: index (staged) status
 *   - column 1: worktree (unstaged) status
 * A space in either column means "no change" for that side.
 *
 * IMPORTANT: callers must pass the RAW, untrimmed output. Trimming the whole
 * record strips the leading space column, which corrupts the staged/unstaged
 * distinction (the bug this plugin was overhauled to fix). The branch is NOT
 * part of porcelain output — it is resolved separately via `rev-parse`.
 */

export type PorcelainEntry = {
  /** Index (staged) status code, e.g. 'M', 'A', 'D', 'R', '?'. Empty if none. */
  index: string;
  /** Worktree (unstaged) status code. Empty if none. */
  worktree: string;
  /** File path. For renames, the source path. */
  from: string;
  /** Destination path, present only for renames (R). */
  to?: string;
  /** True for untracked files (??). */
  untracked: boolean;
};

export type ParsedStatus = {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  entries: PorcelainEntry[];
};

/**
 * Parse raw `git status --porcelain=v1` output into structured buckets.
 *
 * `raw` is the full command output including newlines. We split on `\n` and
 * NEVER trim leading whitespace on individual lines.
 */
export function parsePorcelain(raw: string): ParsedStatus {
  const lines = raw.split('\n');
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const entries: PorcelainEntry[] = [];

  for (const line of lines) {
    // Skip blank lines.
    if (line.length === 0) continue;

    const indexFlag = line[0] ?? ' ';
    const worktreeFlag = line[1] ?? ' ';
    const rest = line.slice(2);

    // Untracked: "?? path"
    if (indexFlag === '?' && worktreeFlag === '?') {
      const filePath = rest.trim();
      untracked.push(filePath);
      entries.push({
        index: '?',
        worktree: '?',
        from: filePath,
        untracked: true,
      });
      continue;
    }

    // Renames look like "R  old -> new" (status code R in either column).
    const renameMatch = rest.match(/^(.+?)\s+->\s+(.+)$/);
    let from = rest.trim();
    let to: string | undefined;
    if (renameMatch && (indexFlag === 'R' || worktreeFlag === 'R')) {
      from = renameMatch[1].trim();
      to = renameMatch[2].trim();
    }

    if (indexFlag !== ' ' && indexFlag !== '?') {
      staged.push(`${indexFlag} ${to ? `${from} -> ${to}` : from}`);
    }
    if (worktreeFlag !== ' ' && worktreeFlag !== '?') {
      unstaged.push(`${worktreeFlag} ${to ? `${from} -> ${to}` : from}`);
    }

    entries.push({
      index: indexFlag === ' ' ? '' : indexFlag,
      worktree: worktreeFlag === ' ' ? '' : worktreeFlag,
      from,
      to,
      untracked: false,
    });
  }

  return { staged, unstaged, untracked, entries };
}
