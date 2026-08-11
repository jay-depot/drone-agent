import { access, readFile, readdir, stat, opendir } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import type { DroneLspDiagnostic, DroneLspServerConfig } from 'drone-core';
import { normalizeFileExtensions } from '../normalize/index.js';

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.drone-agent',
  'dist',
  'build',
  'coverage',
  'node_modules',
]);
const MAX_DOCUMENT_BYTES = 256 * 1024;

export type PublishDiagnosticsParams = {
  uri?: string;
  diagnostics?: Array<{
    range?: {
      start?: { line?: number; character?: number };
      end?: { line?: number; character?: number };
    };
    severity?: number;
    message?: string;
    source?: string;
    code?: string | number;
  }>;
};

export async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function workspaceHasMarkers(
  rootPath: string,
  markers: string[]
): Promise<boolean> {
  for (const marker of markers) {
    if (await pathExists(path.join(rootPath, marker))) {
      return true;
    }
  }

  return false;
}

export async function collectWorkspaceFiles(
  rootPath: string,
  fileExtensions: string[]
): Promise<string[]> {
  const normalizedExtensions = normalizeFileExtensions(fileExtensions);
  const matches: string[] = [];

  async function visitDirectory(directoryPath: string): Promise<void> {
    // Skip directories that are unreadable (e.g. permission-denied) instead
    // of letting the scan throw and abort the whole conversation turn.
    const entries = await readdir(directoryPath, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        await visitDirectory(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (normalizedExtensions.includes(extension)) {
        matches.push(entryPath);
      }
    }
  }

  await visitDirectory(rootPath);
  return matches.sort((left, right) => left.localeCompare(right));
}

/**
 * Check if any files with the given extensions exist in the workspace,
 * excluding common ignore directories. Returns true if at least one
 * matching file is found. Stops scanning early to avoid traversing
 * large trees unnecessarily.
 */
export async function hasMatchingFiles(
  rootPath: string,
  fileExtensions: string[]
): Promise<boolean> {
  const normalizedExtensions = normalizeFileExtensions(fileExtensions);
  if (normalizedExtensions.length === 0) {
    return false;
  }

  async function scanDirectory(directoryPath: string): Promise<boolean> {
    const dir = await opendir(directoryPath).catch(() => null);
    if (!dir) {
      return false;
    }
    for await (const entry of dir) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (await scanDirectory(path.join(directoryPath, entry.name))) {
          return true;
        }
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (normalizedExtensions.includes(extension)) {
        return true;
      }
    }
    return false;
  }

  return scanDirectory(rootPath);
}

export async function connectTcpServer(
  config: Extract<DroneLspServerConfig, { transport: 'tcp' }>,
  timeoutMs: number
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(`Timed out connecting to ${config.host}:${config.port}`)
      );
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function readDocumentSnapshot(filePath: string): Promise<{
  text: string;
  mtimeMs: number;
  size: number;
} | null> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > MAX_DOCUMENT_BYTES) {
    return null;
  }

  const text = await readFile(filePath, 'utf8');
  return {
    text,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  };
}

export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

export function sortDiagnostics(
  diagnostics: DroneLspDiagnostic[]
): DroneLspDiagnostic[] {
  const severityRank: Record<DroneLspDiagnostic['severity'], number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3,
  };

  return [...diagnostics].sort((left, right) => {
    const severityDiff =
      severityRank[left.severity] - severityRank[right.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.range.start.line !== right.range.start.line) {
      return left.range.start.line - right.range.start.line;
    }
    return left.range.start.character - right.range.start.character;
  });
}
