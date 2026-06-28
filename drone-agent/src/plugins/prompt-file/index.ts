import { readFile } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DronePlugin } from 'drone-core';

/**
 * Resolve a prompt-file path pattern to an absolute file path.
 *
 * Supported prefixes:
 *   `~/`  — relative to the user's home directory
 *   `./`  — relative to the current working directory
 *   `..?/` — start at CWD, walk up parent directories until the file is found
 *            (or return null if the root is reached without a match)
 *   (no prefix) — treated as relative to CWD
 *
 * Returns the resolved absolute path if the file exists, or null.
 */
export function resolvePromptFilePath(filePattern: string): string | null {
  if (filePattern.startsWith('~/')) {
    const resolved = path.join(os.homedir(), filePattern.slice(2));
    try {
      accessSync(resolved, fsConstants.F_OK);
      return resolved;
    } catch {
      return null;
    }
  }

  if (filePattern.startsWith('./')) {
    const resolved = path.join(process.cwd(), filePattern.slice(2));
    try {
      accessSync(resolved, fsConstants.F_OK);
      return resolved;
    } catch {
      return null;
    }
  }

  if (filePattern.startsWith('..?/')) {
    const relativePath = filePattern.slice(4);
    let currentDir = path.resolve(process.cwd());
    while (true) {
      const candidate = path.join(currentDir, relativePath);
      try {
        accessSync(candidate, fsConstants.F_OK);
        return candidate;
      } catch {
        const parent = path.dirname(currentDir);
        if (parent === currentDir) {
          return null; // reached root without finding the file
        }
        currentDir = parent;
      }
    }
  }

  // No prefix — treat as relative to CWD
  const resolved = path.resolve(process.cwd(), filePattern);
  try {
    accessSync(resolved, fsConstants.F_OK);
    return resolved;
  } catch {
    return null;
  }
}

async function readFileContent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export const promptFilePlugin: DronePlugin = {
  metadata: {
    id: 'prompt-file',
    name: 'Prompt File',
    version: '0.1.0',
    description:
      'Reads markdown files from configured paths and injects their content as system prompt fragments. Supports ~/ (home), ./ (CWD), and ..?/ (walk up) path prefixes.',
    defaultEnabled: false,
  },
  register: async registration => {
    registration.hooks.onPluginsLoaded(async () => {
      const config = registration.getConfig().promptFile;
      if (!config.enabled) {
        registration.logger.info('prompt-file plugin disabled by config');
        return;
      }

      if (config.files.length === 0) {
        registration.logger.info('prompt-file enabled but no files configured');
        return;
      }

      const resolvedPaths: string[] = [];
      for (const pattern of config.files) {
        const resolvedPath = resolvePromptFilePath(pattern);
        if (!resolvedPath) {
          registration.logger.warn(
            `prompt-file: could not resolve path pattern "${pattern}"`
          );
          continue;
        }

        registration.logger.info(
          `prompt-file: resolved ${pattern} -> ${resolvedPath}`
        );
        resolvedPaths.push(resolvedPath);
      }

      if (resolvedPaths.length === 0) {
        registration.logger.warn(
          'prompt-file: no files could be resolved from the configured patterns'
        );
        return;
      }

      registration.registerPromptFragment({
        key: 'prompt-file-content',
        phase: 'header',
        render: async () => {
          const contents: string[] = [];
          for (const filePath of resolvedPaths) {
            const content = await readFileContent(filePath);
            if (content === null) {
              registration.logger.warn(
                `prompt-file: file not found or unreadable: ${filePath}`
              );
              continue;
            }
            contents.push(`--- ${filePath} ---\n${content}`);
          }
          if (contents.length === 0) return false;
          return `# Prompt Files\n\n` + contents.join('\n\n');
        },
      });
    });
  },
};
