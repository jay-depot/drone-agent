/**
 * Migration Service — YAML frontmatter extraction from .md files.
 */

/**
 * Extract a simple YAML frontmatter field value from a .md file.
 */
export function extractFrontmatterField(
  content: string,
  field: string
): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const lineMatch = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!lineMatch) return undefined;
  return lineMatch[1]
    .trim()
    .replace(/^'(.*)'$/, '$1')
    .replace(/^"(.*)"$/, '$1');
}
