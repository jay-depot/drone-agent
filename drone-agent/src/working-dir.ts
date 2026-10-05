import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Change the process working directory before any config/plugin discovery,
 * so cwd-derived project config, memories, macros and prompt files all resolve
 * against the intended directory. No-op when undefined.
 */
export async function applyWorkingDir(
  workingDir: string | undefined
): Promise<void> {
  if (!workingDir) return;
  const resolved = path.resolve(workingDir);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`--working-dir does not exist: ${workingDir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`--working-dir is not a directory: ${workingDir}`);
  }
  process.chdir(resolved);
}
