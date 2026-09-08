import path from 'node:path';
import { toFileUri } from '../normalize/index.js';
import { resolveLanguageId } from '../known-servers.js';
import { collectWorkspaceFiles, readDocumentSnapshot } from './helpers.js';
import type { PositionDocument } from './position.js';

export type SyncRuntime = {
  id: string;
  language: string;
  fileExtensions: string[];
  client: {
    notify: (method: string, params?: unknown) => void;
  };
  documents: Map<string, PositionDocument>;
};

/**
 * Sync every matching workspace file into the server (didOpen/didChange)
 * and close documents whose files no longer match. Returns the paths whose
 * documents were closed so the caller can drop their cached diagnostics.
 */
export async function syncServerDocuments(
  runtime: SyncRuntime,
  workspaceRoot: string,
  isServerConnected: () => boolean
): Promise<string[]> {
  if (!isServerConnected()) {
    return [];
  }

  const closedPaths: string[] = [];
  const matchingFiles = await collectWorkspaceFiles(
    workspaceRoot,
    runtime.fileExtensions
  );
  const nextFiles = new Set(
    matchingFiles.map(filePath => path.resolve(filePath))
  );

  for (const filePath of matchingFiles) {
    const absolutePath = path.resolve(filePath);
    let snapshot: Awaited<ReturnType<typeof readDocumentSnapshot>>;
    try {
      snapshot = await readDocumentSnapshot(absolutePath);
    } catch {
      continue;
    }
    if (!snapshot) {
      continue;
    }

    const existing = runtime.documents.get(absolutePath);
    if (
      existing &&
      existing.mtimeMs === snapshot.mtimeMs &&
      existing.size === snapshot.size
    ) {
      continue;
    }

    const uri = toFileUri(absolutePath);
    const languageId = resolveLanguageId(absolutePath, runtime.language);
    if (!existing) {
      runtime.client.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: snapshot.text,
        },
      });
      runtime.documents.set(absolutePath, {
        uri,
        languageId,
        version: 1,
        text: snapshot.text,
        mtimeMs: snapshot.mtimeMs,
        size: snapshot.size,
      });
      continue;
    }

    const nextVersion = existing.version + 1;
    runtime.client.notify('textDocument/didChange', {
      textDocument: {
        uri,
        version: nextVersion,
      },
      contentChanges: [{ text: snapshot.text }],
    });
    runtime.documents.set(absolutePath, {
      ...existing,
      version: nextVersion,
      text: snapshot.text,
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
    });
  }

  for (const filePath of Array.from(runtime.documents.keys())) {
    if (nextFiles.has(filePath)) {
      continue;
    }

    const existing = runtime.documents.get(filePath);
    if (!existing) {
      continue;
    }
    runtime.client.notify('textDocument/didClose', {
      textDocument: {
        uri: existing.uri,
      },
    });
    runtime.documents.delete(filePath);
    closedPaths.push(filePath);
  }

  return closedPaths;
}

/**
 * Open a document on the server if it is not already loaded; otherwise
 * return the existing document state.
 */
export async function ensureDocumentLoaded(
  runtime: SyncRuntime,
  filePath: string
): Promise<PositionDocument> {
  const absolutePath = path.resolve(filePath);
  const existing = runtime.documents.get(absolutePath);
  if (existing) {
    return existing;
  }

  const snapshot = await readDocumentSnapshot(absolutePath);
  if (!snapshot) {
    throw new Error(`Could not load LSP document: ${absolutePath}`);
  }

  const documentState: PositionDocument = {
    uri: toFileUri(absolutePath),
    languageId: resolveLanguageId(absolutePath, runtime.language),
    version: 1,
    text: snapshot.text,
    mtimeMs: snapshot.mtimeMs,
    size: snapshot.size,
  };
  runtime.client.notify('textDocument/didOpen', {
    textDocument: {
      uri: documentState.uri,
      languageId: documentState.languageId,
      version: documentState.version,
      text: documentState.text,
    },
  });
  runtime.documents.set(absolutePath, documentState);
  return documentState;
}

/**
 * Sync a single file from disk if it has changed since the last sync.
 * This ensures that if the LLM wrote to a file via file__write in the
 * same turn, the LSP server sees the latest content.
 */
export async function syncFileIfNeeded(
  runtime: SyncRuntime,
  filePath: string
): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const snapshot = await readDocumentSnapshot(absolutePath);
  if (!snapshot) return;

  const existing = runtime.documents.get(absolutePath);
  if (!existing) {
    // File not yet open — will be opened by ensureDocumentLoaded
    return;
  }

  if (
    existing.mtimeMs === snapshot.mtimeMs &&
    existing.size === snapshot.size
  ) {
    return;
  }

  const nextVersion = existing.version + 1;
  runtime.client.notify('textDocument/didChange', {
    textDocument: { uri: existing.uri, version: nextVersion },
    contentChanges: [{ text: snapshot.text }],
  });
  runtime.documents.set(absolutePath, {
    ...existing,
    version: nextVersion,
    text: snapshot.text,
    mtimeMs: snapshot.mtimeMs,
    size: snapshot.size,
  });
}
