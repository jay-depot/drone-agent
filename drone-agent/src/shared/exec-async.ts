/**
 * Reusable async subprocess execution helper.
 *
 * Wraps `execFile` from `node:child_process` with `promisify` for
 * async/await usage. Uses args arrays (not shell strings) to avoid
 * shell injection and quoting issues.
 *
 * @internal Not part of the public API.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

export type ExecFileResult = {
  stdout: string;
  stderr: string;
};

export type ExecFileOptions = {
  cwd?: string;
  maxBuffer?: number;
};

/**
 * Execute a command with args array. Returns stdout and stderr as strings.
 * Throws if the process exits with a non-zero code.
 */
export async function execFileAsync(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<ExecFileResult> {
  const { stdout, stderr } = await execFilePromise(command, args, {
    encoding: 'utf-8',
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    cwd: options.cwd,
  });
  return { stdout, stderr };
}
