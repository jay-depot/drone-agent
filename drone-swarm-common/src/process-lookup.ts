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

/**
 * Outcome of a pid lookup. `unavailable` means enumeration could not run at
 * all (missing or busybox `ps`); it is NOT the same as `absent`, which is a
 * positive finding that no process carries the id. Callers that decide
 * liveness must never treat `unavailable` as `absent`.
 */
export type ProcessLookupResult =
  | { status: 'found'; pid: number }
  | { status: 'absent' }
  | { status: 'unavailable' };

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
 * List OS processes via `ps`, or null when enumeration is unavailable
 * (missing or busybox `ps`). A caller must treat null as "cannot determine"
 * rather than "nothing found".
 *
 * `-ww` disables command-column truncation (procps and BSD both honor it), so
 * a long command tail cannot hide the flag we match on.
 */
export async function listProcesses(): Promise<ProcessInfo[] | null> {
  try {
    const { stdout } = await execFileAsync('ps', [
      '-A',
      '-ww',
      '-o',
      'pid=,command=',
    ]);
    return parsePsOutput(stdout);
  } catch (err) {
    if (!psUnavailableLogged) {
      psUnavailableLogged = true;
      logger.warn(
        `Process enumeration unavailable (ps failed): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return null;
  }
}

/**
 * Find the pid whose argv carries an exact `--spawn-id <spawnId>` pair.
 * Returns null when no process in the given list matches.
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
 * Look up a spawned agent's pid by its spawn id. Returns `found` with the pid,
 * `absent` when enumeration ran and no process carries the id, or
 * `unavailable` when enumeration could not run.
 */
export async function findPidBySpawnId(
  spawnId: string
): Promise<ProcessLookupResult> {
  const processes = await listProcesses();
  if (processes === null) {
    return { status: 'unavailable' };
  }
  const pid = matchPidBySpawnId(processes, spawnId);
  return pid === null ? { status: 'absent' } : { status: 'found', pid };
}
