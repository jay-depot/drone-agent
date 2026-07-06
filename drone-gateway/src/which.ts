import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a binary name to its full path using the PATH environment variable.
 * Throws if the binary is not found.
 */
export async function which(name: string): Promise<string> {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter);

  for (const dir of dirs) {
    const fullPath = path.join(dir, name);
    try {
      await access(fullPath, constants.X_OK);
      return fullPath;
    } catch {
      // Not found in this directory, continue
    }
  }

  throw new Error(`Binary not found in PATH: ${name}`);
}
