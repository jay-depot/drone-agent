/**
 * Convert Obsidian-style [[wikilinks]] into standard markdown links so
 * react-markdown can render them and the custom `a` component can route them.
 *
 * - `[[target]]` → `[target](/wiki/<encodeURIComponent(target)>)`
 * - `[[target|alias]]` → `[alias](/wiki/<encodeURIComponent(target)>)`
 *
 * Markdown special characters in the label/alias are escaped so the rendered
 * link text matches the source exactly.
 */

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function escapeLabel(text: string): string {
  return text.replace(/([\\`*_[\]()#+.!~|<>])/g, '\\$1');
}

export function preprocessWikiLinks(content: string): string {
  return content.replace(
    WIKILINK_RE,
    (_match, target: string, alias?: string) => {
      const href = `/wiki/${encodeURIComponent(target.trim())}`;
      const label = escapeLabel((alias ?? target).trim());
      return `[${label}](${href})`;
    }
  );
}
