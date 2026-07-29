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
      const sentences = chunk.match(/[^.!?\n]+[.!?]*/g) || [chunk];
      let sentenceBuf = '';
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (sentenceBuf.length + s.length + 1 > maxChars) {
          if (sentenceBuf.length > 0) result.push(sentenceBuf);
          sentenceBuf = s;
        } else if (sentenceBuf.length === 0) {
          sentenceBuf = s;
        } else {
          sentenceBuf += ' ' + s;
        }
      }
      if (sentenceBuf.length > 0) result.push(sentenceBuf);
    } else {
      result.push(chunk);
    }
  }

  return result;
}
