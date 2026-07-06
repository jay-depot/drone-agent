/**
 * Migration Service — backup helper.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function backupAsset(
  filePath: string,
  backupPath: string
): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const dir = path.dirname(backupPath);
  await mkdir(dir, { recursive: true });
  await writeFile(backupPath, content, 'utf-8');
}
