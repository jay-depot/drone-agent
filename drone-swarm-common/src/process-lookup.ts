import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * A process visible to the OS, with its command line split into argv tokens.
 */
export interface ProcessInfo {
  pid: number;
  argv: string[];
}

const SPAWN_ID_FLAG = '--spawn-id';

let psUnavailableLogged = false;

/**
 * Parse `ps -A -o pid=,command=` output into pid/argv pairs.
 *
 * `command=` prints the full command line on a single line per process; we
 * tokenize on whitespace. This is sufficient for matching the space-free
 * `--spawn-id <uuid>` pair, and it is the same shape on Linux and macOS.
 */
export function parsePsOutput(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      argv: match[2].trim().split(/\s+/),
    });
  }
  return processes;
}

/**
 * List OS processes via `ps`, or an empty array when enumeration is
 * unavailable (missing or busybox `ps`). Enumeration failure degrades
 * gracefully: a caller must treat "nothing found" as "cannot confirm a live
 * process" and never as "confirmed dead".
 *
 * `-ww` disables command-column truncation (procps and BSD both honor it), so
 * a long command tail cannot hide the flag we match on.
 */
export async function listProcesses(): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,command=']);
    return parsePsOutput(stdout);
  } catch (err) {
    if (!psUnavailableLogged) {
      psUnavailableLogged = true;
      logger.warn(
        `Process enumeration unavailable (ps failed): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return [];
  }
}

/**
 * Find the pid whose argv carries an exact `--spawn-id <spawnId>` pair.
 * Returns null when no process matches.
 */
export function matchPidBySpawnId(
  processes: readonly ProcessInfo[],
  spawnId: string
): number | null {
  for (const proc of processes) {
    const idx = proc.argv.indexOf(SPAWN_ID_FLAG);
    if (idx !== -1 && proc.argv[idx + 1] === spawnId) {
      return proc.pid;
    }
  }
  return null;
}

/**
 * Look up a spawned agent's pid by its spawn id. Returns null when no live
 * process carries the id.
 */
export async function findPidBySpawnId(
  spawnId: string
): Promise<number | null> {
  return matchPidBySpawnId(await listProcesses(), spawnId);
}
