import { chunkMarkdown, chunkLines, chunkText } from 'drone-swarm-common';
import { chunkCode } from './code-chunker.js';
import path from 'node:path';

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const LINE_EXTS = new Set(['.json', '.yaml', '.yml']);
const TEMPLATE_EXTS = new Set(['.hbs', '.handlebars', '.gradle', '.tmpl']);

/**
 * Chunk a file's content by routing on its extension to the appropriate
 * strategy: AST-aware for code, heading/paragraph for Markdown, line-based
 * for JSON/YAML, whole-file for templates, and paragraph fallback for
 * anything else (including code without a registered grammar).
 */
export async function chunkFile(
  filePath: string,
  content: string,
  maxTokens: number
): Promise<string[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (MARKDOWN_EXTS.has(ext)) {
    return chunkMarkdown(content, maxTokens);
  }
  if (LINE_EXTS.has(ext)) {
    return chunkLines(content, maxTokens);
  }
  if (TEMPLATE_EXTS.has(ext)) {
    const trimmed = content.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  const codeChunks = await chunkCode(filePath, content, maxTokens);
  if (codeChunks !== null) {
    return codeChunks;
  }
  return chunkText(content, maxTokens);
}
