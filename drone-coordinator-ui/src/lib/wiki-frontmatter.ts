/**
 * Split a leading YAML frontmatter block off the start of wiki page content.
 *
 * The coordinator-wiki-librarian persona sometimes embeds a redundant YAML
 * frontmatter block (id, title, scope, tags, sources) at the top of the page
 * body, duplicating the structured fields the coordinator already stores. The
 * browser collapses that block into a disclosure instead of rendering it as
 * raw text. This helper detects and extracts it.
 *
 * Uses the same leading-frontmatter regex shape as `wiki-storage.ts` in
 * drone-swarm-common. Returns the raw YAML text (without the `---` fences) and
 * the remaining body. When there is no leading block, `frontmatter` is `null`
 * and `body` is the full content.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function splitFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  return { frontmatter: match[1], body: match[2].trimStart() };
}
