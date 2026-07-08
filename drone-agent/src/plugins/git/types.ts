/** Shared types for git plugin tool results and TUI components. */

/**
 * A single list item with a kind-driven color:
 *   - 'added'   (new file on FS): green
 *   - 'modified'(changed existing file): cyan
 *   - 'removed' (deleted from FS): red + strikethrough
 *   - 'renamed' (moved file): kept for completeness; renames from
 *     `git diff --name-status` are normalized to `added`/`removed` pairs below
 */
export type ListItem = {
  kind: 'added' | 'modified' | 'removed' | 'renamed';
  path: string;
};

/**
 * Convert `git diff --name-status` (or `git stash show -u --name-status`)
 * output into ListItems, coloring by the actual filesystem change.
 *
 * Format is TAB-separated: `<code>TAB<path>` for most codes, and
 * `<code>TAB<from>TAB<to>` for renames/copies (e.g. `R050\told.ts\tnew.ts`).
 * NOTE: this parser is specifically for `--name-status` output. It must NOT
 * be fed `git status --porcelain` (which is space-separated and uses `??`,
 * renames there are `R  old -> new`, and untracked is `??`) — use
 * `git diff --name-status` instead, which is what add/restore/stash all use.
 *
 * Status codes: A (added), M (modified), D (deleted), R (renamed),
 * C (copied), U (unmerged).
 */
export function nameStatusToItems(raw: string): ListItem[] {
  const lines = raw
    .split('\n')
    .map(l => l.replace(/\s+$/, '')) // trailing only; preserve leading codes
    .filter(Boolean);
  const items: ListItem[] = [];
  for (const line of lines) {
    // Format: <code><TAB><from>[\t<to>]  (rename/copy carry a second path).
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue; // malformed / empty — skip
    const code = line.slice(0, tabIdx).trim();
    const rest = line.slice(tabIdx + 1);
    const parts = rest
      .split('\t')
      .map(p => p.trim())
      .filter(Boolean);

    let kind: ListItem['kind'];
    if (code.startsWith('D')) {
      kind = 'removed';
    } else if (code.startsWith('A')) {
      kind = 'added';
    } else if (code.startsWith('M') || code.startsWith('U')) {
      kind = 'modified';
    } else if (code.startsWith('R') || code.startsWith('C')) {
      // Rename/copy: emit as removed(old) + added(new) so the TUI shows the
      // actual filesystem change on both sides (matches stash --name-status).
      if (parts.length >= 2) {
        items.push({ kind: 'removed', path: parts[0] });
        items.push({ kind: 'added', path: parts[1] });
      } else if (parts.length === 1) {
        items.push({ kind: 'added', path: parts[0] });
      }
      continue;
    } else {
      kind = 'modified';
    }
    items.push({ kind, path: parts[parts.length - 1] ?? rest });
  }
  return items;
}
