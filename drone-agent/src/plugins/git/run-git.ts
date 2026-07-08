import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

/**
 * Run a git command, returning trimmed stdout.
 *
 * Trimming is safe for commands whose output has no positional leading
 * whitespace semantics (diff, log, rev-parse, show, branch, stash, fetch,
 * pull, ...). It must NOT be used for `status --porcelain` — see
 * `statusPorcelain` below.
 */
export async function runGit(args: string[], cwd?: string): Promise<string> {
  const dir = cwd ?? process.cwd();
  const { stdout } = await execFilePromise('git', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    cwd: dir,
  });
  return stdout.trim();
}

/**
 * Run `git status --porcelain=v1` and return the RAW, untrimmed output.
 *
 * Leading whitespace is significant (column 0 = staged flag), so the output
 * is intentionally NOT trimmed — the parser handles line scrubbing.
 */
export async function statusPorcelain(cwd?: string): Promise<string> {
  const dir = cwd ?? process.cwd();
  const { stdout } = await execFilePromise(
    'git',
    ['status', '--porcelain=v1'],
    {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      cwd: dir,
    }
  );
  return stdout;
}

/** Resolve a non-empty cwd string or undefined (defaults to process.cwd()). */
export function resolveCwd(input: Record<string, unknown>): string | undefined {
  const raw = input.cwd;
  return typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

/** Extract a required non-empty string field, throwing if absent. */
export function requireString(
  input: Record<string, unknown>,
  key: string
): string {
  const raw = input[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`git tool requires a non-empty "${key}" string.`);
  }
  return raw.trim();
}
