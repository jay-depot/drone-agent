import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { DronePortableContextExport } from 'drone-core';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Directory holding checkpoint files for the current project. */
export function checkpointDir(): string {
  return path.join(process.cwd(), '.drone-agent', 'checkpoints');
}

/**
 * Validate a checkpoint name. Names map 1:1 to filenames, so path separators,
 * `..`, empty names, and any character outside `[A-Za-z0-9._-]` are rejected —
 * this is the path-traversal boundary.
 */
export function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Checkpoint name must not be empty.');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`Invalid checkpoint name: "${name}".`);
  }
  if (!NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid checkpoint name: "${name}". Use only letters, digits, ".", "_", and "-".`
    );
  }
  return trimmed;
}

function checkpointPath(name: string): string {
  return path.join(checkpointDir(), `${sanitizeName(name)}.json`);
}

/** Write a checkpoint atomically (tmp file + rename). Creates the dir. */
export async function writeCheckpoint(
  name: string,
  data: DronePortableContextExport
): Promise<void> {
  const target = checkpointPath(name);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, target);
}

export async function readCheckpoint(
  name: string
): Promise<DronePortableContextExport> {
  const raw = await readFile(checkpointPath(name), 'utf8');
  return JSON.parse(raw) as DronePortableContextExport;
}

export async function deleteCheckpoint(name: string): Promise<void> {
  await unlink(checkpointPath(name));
}

/** Rename a checkpoint (read + write-new + unlink-old). */
export async function renameCheckpoint(
  oldName: string,
  newName: string
): Promise<void> {
  const data = await readCheckpoint(oldName);
  await writeCheckpoint(newName, data);
  await deleteCheckpoint(oldName);
}

/** List checkpoint names (filename without the `.json` extension), sorted. */
export async function listCheckpoints(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(checkpointDir());
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.endsWith('.json'))
    .map(entry => entry.slice(0, -'.json'.length))
    .sort();
}
