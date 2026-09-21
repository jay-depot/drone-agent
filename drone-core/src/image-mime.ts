// ── Image MIME detection ────────────────────────────────────────────
//
// Single source of truth for which file extensions count as images and what
// MIME type they carry. Shared by `file__read_image` and the `file`
// `@`-reference resolver so the two can never disagree.
//
// Deliberately dependency-free (no node:path / node:fs) so drone-core stays
// importable outside Node.

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Extensions (with leading dot) recognized as images, in declaration order. */
export const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] =
  Object.keys(IMAGE_MIME_BY_EXT);

/**
 * MIME type for an extension (e.g. `.png`), or `undefined` when the extension
 * is not a recognized image format. Case-insensitive.
 */
export function imageMimeForExtension(ext: string): string | undefined {
  const dot = ext.lastIndexOf('.');
  if (dot < 0) return undefined;
  return IMAGE_MIME_BY_EXT[ext.slice(dot).toLowerCase()];
}

/**
 * MIME type for a file path, or `undefined` when the path's extension is not a
 * recognized image format. Extension-only (no content sniffing).
 */
export function imageMimeForPath(filePath: string): string | undefined {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return imageMimeForExtension(filePath.slice(slash + 1));
}
