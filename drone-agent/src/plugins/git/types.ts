/** Shared types for git plugin tool results and TUI components. */

/**
 * A single list item with a kind-driven color:
 *   - 'added'   (new file on FS): green
 *   - 'modified'(changed existing file): cyan
 *   - 'removed' (deleted from FS): red + strikethrough
 */
export type ListItem = {
  kind: 'added' | 'modified' | 'removed';
  path: string;
};

/**
 * Convert `git diff --name-status` (or `git stash show --name-status`) output
 * into ListItems, coloring by the actual filesystem change.
 *
 * Status codes: A (added), M (modified), D (deleted), R (renamed),
 * C (copied), U (unmerged). Renames/copies carry a `from -> to` second line.
 */
export function nameStatusToItems(raw: string): ListItem[] {
  const lines = raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const items: ListItem[] = [];
  for (const line of lines) {
    const spaceIdx = line.indexOf(' ');
    const code = spaceIdx >= 0 ? line.slice(0, spaceIdx) : line;
    const rest = spaceIdx >= 0 ? line.slice(spaceIdx + 1) : '';
    const paths = rest
      .split('\t')
      .map(p => p.trim())
      .filter(Boolean);
    // For renames/copies git emits "R100\tfrom\tto".
    const path = paths[paths.length - 1] ?? rest;

    let kind: ListItem['kind'];
    if (code.startsWith('A') || code.startsWith('R') || code.startsWith('C')) {
      kind = 'added';
    } else if (code.startsWith('D')) {
      kind = 'removed';
    } else {
      kind = 'modified';
    }
    items.push({ kind, path });
  }
  return items;
}
