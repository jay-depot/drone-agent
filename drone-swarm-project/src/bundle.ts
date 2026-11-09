import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The front-end bundle shipped by `drone-swarm-project`.
 *
 * Unlike `mcp-swarm` (which embeds a JS string), this bundle is a real esbuild
 * output: TSX under `bundle/` compiled to `dist/bundle/index.js` plus
 * `dist/bundle/style.css`. At startup the node reads those files and uploads
 * them base64.
 */
export const BUNDLE = { name: 'board', version: '0.1.0' };

export interface BundleFileDefinition {
  name: string;
  contentBase64: string;
  contentType: string;
}

const BUNDLE_FILES: Array<{ name: string; contentType: string }> = [
  { name: 'index.js', contentType: 'application/javascript' },
  { name: 'style.css', contentType: 'text/css' },
];

/**
 * Resolve the package root from this module's location. This file is compiled
 * from `src/bundle.ts` into `dist/bundle.js`, so the package root is one level
 * above the compiled file's directory.
 */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Read the built bundle files and return the upload payload. Throws a clear
 * error when a file is absent; the caller logs it and continues (non-fatal),
 * exactly like `mcp-swarm`.
 */
export async function buildBundleFiles(): Promise<BundleFileDefinition[]> {
  const root = packageRoot();
  const files: BundleFileDefinition[] = [];
  for (const file of BUNDLE_FILES) {
    const filePath = path.join(root, 'dist', 'bundle', file.name);
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      throw new Error(
        `drone-swarm-project: bundle file missing at ${filePath} — run "pnpm --filter drone-swarm-project run build"`
      );
    }
    files.push({
      name: file.name,
      contentBase64: content.toString('base64'),
      contentType: file.contentType,
    });
  }
  return files;
}
