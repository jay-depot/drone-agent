/**
 * Derive persona `name` / `description` metadata from the `.md` content stored
 * in a persona's `systemPrompt` column.
 *
 * The `.md` file (YAML frontmatter + body) is the source of truth for a
 * persona's metadata; the persona table's `name`/`description` columns are a
 * derived projection kept in sync at write time. The derivation mirrors the
 * runtime loader (`drone-agent` persona loader) exactly so the persisted
 * columns never diverge from what the agent sees.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

const stripQuotes = (raw: string): string =>
  raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

/**
 * Return `{ name, description }` derived from a persona's `.md` content.
 *
 * Uses `frontmatter.name` / `frontmatter.description` when present, else
 * falls back to the `id` and `Persona: ${id}` (matching the runtime loader).
 */
export function derivePersonaMetadata(
  systemPrompt: string,
  id: string
): { name: string; description: string } {
  let name = id;
  let description = `Persona: ${id}`;

  const match = systemPrompt.match(FRONTMATTER_RE);
  if (!match) return { name, description };

  // Indented `key: value` lines following `premountedTools:` are plugin ids,
  // not metadata keys. Track that nested block so a plugin id named `name`
  // cannot be mistaken for the persona's name.
  let inPremount = false;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const indent = kv[1];
    const key = kv[2];
    const raw = kv[3];

    if (inPremount && indent.length > 0) continue;
    inPremount = false;

    if (key === 'premountedTools') {
      if (stripQuotes(raw.trim()) === '') inPremount = true;
      continue;
    }

    if (key === 'name') {
      name = stripQuotes(raw.trim());
    } else if (key === 'description') {
      description = stripQuotes(raw.trim());
    }
  }

  return { name, description };
}
