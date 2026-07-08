import type { MarkdownRenderer, RenderedMessage } from './types.js';

/**
 * BasicMarkdownRenderer converts a subset of markdown to Matrix-compatible HTML.
 *
 * Supported: code fences, inline code, bold, italic, links, unordered/ordered
 * lists, and paragraph breaks. HTML in input is escaped to prevent injection.
 *
 * This is intentionally minimal — if richer rendering is needed, swap this
 * implementation for a library like `marked` behind the same MarkdownRenderer
 * interface.
 */
export class BasicMarkdownRenderer implements MarkdownRenderer {
  render(md: string): RenderedMessage {
    try {
      const body = md;
      const formattedBody = this.renderToHtml(md);
      return { body, formattedBody };
    } catch {
      // On any parse failure, fall back to plain text
      return { body: md, formattedBody: null };
    }
  }

  private renderToHtml(md: string): string {
    // Split into code-fence blocks and everything else
    const fenceRegex = /```(\w*)\n([\s\S]*?)```/g;
    const parts: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = fenceRegex.exec(md)) !== null) {
      // Push the text before this fence (process inline formatting)
      parts.push(
        this.renderInline(this.escapeHtml(md.slice(lastIndex, match.index)))
      );
      // Push the fenced code block as-is (escaped, wrapped in pre>code)
      const lang = match[1];
      const code = this.escapeHtml(match[2].replace(/\n$/, '')); // trim trailing newline
      const langAttr = lang
        ? ` class="language-${this.escapeHtml(lang)}"`
        : '';
      parts.push(`<pre><code${langAttr}>${code}</code></pre>`);
      lastIndex = match.index + match[0].length;
    }

    // Push remaining text after last fence
    parts.push(this.renderInline(this.escapeHtml(md.slice(lastIndex))));

    return parts.join('');
  }

  /**
   * Render inline markdown (no code fences) to HTML.
   * Input is already HTML-escaped.
   */
  private renderInline(text: string): string {
    let html = text;

    // Inline code: `code` → <code>code</code>
    // Must be processed before bold/italic to avoid conflicts
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Links: [text](url) → <a href="url">text</a>
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2">$1</a>'
    );

    // Bold: **text** → <strong>text</strong>
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic: *text* → <em>text</em>
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Wrap consecutive lines in <p> tags (blank-line-separated paragraphs)
    const paragraphs = html.split(/\n\n+/);
    if (paragraphs.length > 1 || paragraphs[0].trim()) {
      html = paragraphs
        .map(p => {
          const trimmed = p.trim();
          if (!trimmed) return '';
          // Process lists within each paragraph block
          return this.renderLists(trimmed);
        })
        .filter(Boolean)
        .join('\n');
    } else {
      html = this.renderLists(html.trim());
    }

    return html;
  }

  /**
   * Render unordered (- ) and ordered (1. ) lists within a paragraph block.
   * Input is a single paragraph block (no blank lines inside).
   */
  private renderLists(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Unordered list
      const ulMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (ulMatch) {
        const items: string[] = [ulMatch[2]];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          const nextMatch = next.match(/^(\s*)[-*]\s+(.*)$/);
          if (nextMatch) {
            items.push(nextMatch[2]);
            i++;
          } else {
            break;
          }
        }
        result.push(
          '<ul>\n' +
            items.map(item => `  <li>${item}</li>`).join('\n') +
            '\n</ul>'
        );
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (olMatch) {
        const items: string[] = [olMatch[2]];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          const nextMatch = next.match(/^(\s*)\d+\.\s+(.*)$/);
          if (nextMatch) {
            items.push(nextMatch[2]);
            i++;
          } else {
            break;
          }
        }
        result.push(
          '<ol>\n' +
            items.map(item => `  <li>${item}</li>`).join('\n') +
            '\n</ol>'
        );
        continue;
      }

      // Regular line — wrap in <p> if non-empty
      if (line.trim()) {
        result.push(`<p>${line.trim()}</p>`);
      }
      i++;
    }

    return result.join('\n');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
