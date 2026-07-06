import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function fromFileUri(uri: string): string | null {
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return null;
  }
}
