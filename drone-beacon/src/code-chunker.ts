import { Parser, Language, type Node } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ── Grammar registry ────────────────────────────────────────────────
// Maps a file extension to the tree-sitter grammar wasm to use for it.
// Adding a language = one registry line + one dependency.
const GRAMMAR_REGISTRY: Record<string, string> = {
  '.ts': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  '.tsx': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  '.js': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  '.mjs': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  '.cjs': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  '.py': 'tree-sitter-python/tree-sitter-python.wasm',
  '.c': 'tree-sitter-c/tree-sitter-c.wasm',
  '.h': 'tree-sitter-c/tree-sitter-c.wasm',
  '.cpp': 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  '.cc': 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  '.cxx': 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  '.hpp': 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  '.hh': 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  '.hxx': 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  '.rs': 'tree-sitter-rust/tree-sitter-rust.wasm',
  '.go': 'tree-sitter-go/tree-sitter-go.wasm',
  '.java': 'tree-sitter-java/tree-sitter-java.wasm',
};

// ── Parser / language caching ──────────────────────────────────────

let parserInitPromise: Promise<void> | null = null;
let parserInstance: Parser | null = null;
const languageCache = new Map<string, Promise<Language>>();

async function getParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  if (!parserInitPromise) {
    parserInitPromise = (async () => {
      const wasm = await readFile(
        require.resolve('web-tree-sitter/web-tree-sitter.wasm')
      );
      await Parser.init({ wasmBinary: wasm });
    })();
  }
  await parserInitPromise;
  parserInstance = new Parser();
  return parserInstance;
}

function getLanguage(grammarPath: string): Promise<Language> {
  let cached = languageCache.get(grammarPath);
  if (!cached) {
    cached = (async () => {
      const wasm = await readFile(require.resolve(grammarPath));
      return Language.load(wasm);
    })();
    languageCache.set(grammarPath, cached);
  }
  return cached;
}

// ── Chunking ────────────────────────────────────────────────────────

type Unit = {
  /** Byte range of the declaration itself (excludes any leading comment). */
  start: number;
  end: number;
  /** Leading comment/docstring text to prepend to the first chunk. */
  commentPrefix: string;
};

/**
 * Chunk source code at AST boundaries (functions, classes, imports, etc.).
 * Returns `null` when the file extension has no registered grammar, so the
 * caller can fall back to a non-AST chunker.
 *
 * The token target is a bias, not a hard limit: adjacent small units are
 * merged up to 0.5× the target, oversized units are split at inner statement
 * boundaries above 2× the target, and everything in between is kept whole.
 */
export async function chunkCode(
  filePath: string,
  content: string,
  maxTokens: number
): Promise<string[] | null> {
  const ext = path.extname(filePath).toLowerCase();
  const grammarPath = GRAMMAR_REGISTRY[ext];
  if (!grammarPath) return null;

  const parser = await getParser();
  const language = await getLanguage(grammarPath);
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) return null;

  const root = tree.rootNode;
  const maxChars = maxTokens * 4;
  const minChars = Math.floor(maxChars * 0.5);

  // Collect top-level units, attaching leading comments to the following
  // declaration so docstrings stay with their function.
  const units: Unit[] = [];
  let pendingComment: string[] = [];
  for (const child of root.namedChildren) {
    // Comments are extra nodes; ERROR nodes are also marked extra but must be
    // kept as units so a file with a syntax error still gets indexed.
    if (child.isExtra && !child.isError) {
      pendingComment.push(child.text);
      continue;
    }
    units.push({
      start: child.startIndex,
      end: child.endIndex,
      commentPrefix: pendingComment.join('\n'),
    });
    pendingComment = [];
  }
  if (pendingComment.length > 0 && units.length > 0) {
    units[units.length - 1].commentPrefix += '\n' + pendingComment.join('\n');
  }

  // Merge adjacent small units up to minChars. Merged units are always
  // <= maxChars, so only single declarations can be oversized.
  const merged: Unit[] = [];
  for (const unit of units) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.end - last.start < minChars &&
      last.end - last.start + (unit.end - unit.start) <= maxChars
    ) {
      last.end = unit.end;
    } else {
      merged.push({ ...unit });
    }
  }

  const chunks: string[] = [];
  for (const unit of merged) {
    const size = unit.end - unit.start;
    let unitChunks: string[];
    if (size <= maxChars) {
      unitChunks = [content.slice(unit.start, unit.end).trim()];
    } else {
      const node = root.namedDescendantForIndex(unit.start, unit.end);
      unitChunks = node
        ? splitOversized(node, content, maxChars)
        : [content.slice(unit.start, unit.end).trim()];
    }
    if (unit.commentPrefix && unitChunks.length > 0) {
      unitChunks[0] = unit.commentPrefix + '\n' + unitChunks[0];
    }
    for (const text of unitChunks) {
      if (text.length > 0) chunks.push(text);
    }
  }

  return chunks;
}

/**
 * Split an oversized node into chunks at its named-child (statement)
 * boundaries, never mid-statement. Greedily packs children into groups of at
 * most maxChars, recursing into any single child that is itself oversized.
 *
 * If the node has a body (e.g. a function's statement_block), the header
 * (everything before the body) is kept attached to the first body chunk so a
 * signature is never orphaned from its implementation.
 */
function splitOversized(
  node: Node,
  content: string,
  maxChars: number
): string[] {
  const size = node.endIndex - node.startIndex;
  if (size <= maxChars) {
    return [content.slice(node.startIndex, node.endIndex).trim()];
  }

  // If this node has a body child, split the body and prepend the header to
  // the first chunk so the signature stays with its implementation.
  const body = node.namedChildren.find(c => c.type === 'statement_block');
  if (body) {
    const header = content.slice(node.startIndex, body.startIndex).trim();
    const bodyChunks = splitOversized(body, content, maxChars);
    if (bodyChunks.length > 0) {
      bodyChunks[0] = header + '\n' + bodyChunks[0];
    }
    return bodyChunks;
  }

  const children = node.namedChildren;
  if (children.length === 0) {
    return [content.slice(node.startIndex, node.endIndex).trim()];
  }

  const result: string[] = [];
  let group: Node[] = [children[0]];
  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    // The group's span includes inter-statement whitespace, so measure the
    // actual text span (first child start to last child end) rather than the
    // sum of child sizes.
    const span = child.endIndex - group[0].startIndex;
    if (span <= maxChars) {
      group.push(child);
    } else {
      result.push(...emitGroup(group, content, maxChars));
      group = [child];
    }
  }
  result.push(...emitGroup(group, content, maxChars));
  return result;
}

function emitGroup(group: Node[], content: string, maxChars: number): string[] {
  const start = group[0].startIndex;
  const end = group[group.length - 1].endIndex;
  if (end - start <= maxChars) {
    return [content.slice(start, end).trim()];
  }
  // A single oversized child — recurse into it.
  return splitOversized(group[0], content, maxChars);
}
