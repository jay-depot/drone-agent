/**
 * Split text into chunks by paragraph boundaries, respecting max tokens.
 * Uses a rough token estimate of ~4 chars per token.
 */
export function chunkText(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;

  // Split by double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const paraTrimmed = para.trim();
    if (
      current.length > 0 &&
      current.length + paraTrimmed.length + 2 > maxChars
    ) {
      chunks.push(current);
      current = paraTrimmed;
    } else if (current.length === 0) {
      current = paraTrimmed;
    } else {
      current += '\n\n' + paraTrimmed;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  // If any chunk is still too long (single huge paragraph), split by sentences
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length > maxChars) {
      result.push(...splitBySentences(chunk, maxChars));
    } else {
      result.push(chunk);
    }
  }

  return result;
}

/**
 * Split markdown text into chunks by heading boundaries, respecting max tokens.
 * Each chunk groups a heading with the paragraphs that follow it (until the next
 * heading). Oversized sections are split at paragraph boundaries, then by
 * sentences if a single paragraph is still too long.
 * Uses a rough token estimate of ~4 chars per token.
 */
export function chunkMarkdown(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;

  // Group lines into sections, each starting at a heading.
  const sections: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      sections.push(current.join('\n').trim());
      current = [];
    }
  };

  for (const line of text.split('\n')) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();

  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= maxChars) {
      chunks.push(section);
      continue;
    }

    // Split oversized section at paragraph boundaries.
    const paragraphs = section
      .split(/\n\s*\n+/)
      .filter(p => p.trim().length > 0);
    let buf = '';
    for (const para of paragraphs) {
      const p = para.trim();
      if (buf.length > 0 && buf.length + p.length + 2 > maxChars) {
        chunks.push(buf);
        buf = p;
      } else if (buf.length === 0) {
        buf = p;
      } else {
        buf += '\n\n' + p;
      }
    }
    if (buf.length > 0) chunks.push(buf);
  }

  // Split any remaining oversized chunks (single huge paragraph) by sentences.
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length > maxChars) {
      result.push(...splitBySentences(chunk, maxChars));
    } else {
      result.push(chunk);
    }
  }

  return result;
}

/**
 * Split text into chunks by lines with a sliding window, respecting max tokens.
 * Used for line-oriented formats (JSON, YAML) where structure is shallow.
 * Uses a rough token estimate of ~4 chars per token.
 */
export function chunkLines(
  text: string,
  maxTokens: number,
  linesPerChunk = 15,
  overlap = 3
): string[] {
  const maxChars = maxTokens * 4;
  const lines = text.split('\n');
  const step = Math.max(1, linesPerChunk - overlap);
  const chunks: string[] = [];

  for (let i = 0; i < lines.length; i += step) {
    const chunk = lines
      .slice(i, i + linesPerChunk)
      .join('\n')
      .trim();
    if (chunk.length === 0) continue;
    if (chunk.length > maxChars) {
      chunks.push(...splitBySentences(chunk, maxChars));
    } else {
      chunks.push(chunk);
    }
  }

  return chunks;
}

/**
 * Split an oversized block of text into sentence-sized chunks, each within
 * maxChars. Used as a fallback when paragraph/heading boundaries can't keep
 * chunks under the size budget.
 */
function splitBySentences(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*/g) || [text];
  const result: string[] = [];
  let buf = '';

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (buf.length + s.length + 1 > maxChars) {
      if (buf.length > 0) result.push(buf);
      buf = s;
    } else if (buf.length === 0) {
      buf = s;
    } else {
      buf += ' ' + s;
    }
  }

  if (buf.length > 0) result.push(buf);
  return result;
}
