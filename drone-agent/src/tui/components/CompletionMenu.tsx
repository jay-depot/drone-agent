/**
 * Completion menu for the TUI input line.
 *
 * A short list of candidates shown between the input line and the status bar.
 * Up to `MENU_LIMIT` rows are visible; a sliding window keeps the selected row
 * on screen. The selected row carries a `▶ ` marker and is highlighted; each
 * row may carry a dim hint (description) to its right.
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { DroneColorScheme } from '../theme.js';
import type { CompletionItem } from '../completion.js';
import { MENU_LIMIT } from '../hooks/useCompletion.js';

export function CompletionMenu({
  items,
  selectedIndex,
  scheme,
}: {
  items: CompletionItem[];
  selectedIndex: number;
  scheme: DroneColorScheme;
}): React.JSX.Element | null {
  if (items.length === 0) {
    return null;
  }

  // Sliding window so the selected row stays visible.
  let start = 0;
  if (selectedIndex >= MENU_LIMIT) {
    start = selectedIndex - MENU_LIMIT + 1;
  }
  const shown = items.slice(start, start + MENU_LIMIT);
  const remaining = items.length - (start + shown.length);

  return (
    <Box flexDirection="column" paddingX={1}>
      {shown.map((item, offset) => {
        const idx = start + offset;
        const selected = idx === selectedIndex;
        return (
          <Box key={item.id} flexDirection="row">
            <Text color={scheme.userInput}>{selected ? '▶ ' : '  '}</Text>
            <Text color={selected ? scheme.primary : scheme.info}>
              {item.display}
            </Text>
            {item.hint ? (
              <Text color={scheme.statusFg}> {item.hint}</Text>
            ) : null}
          </Box>
        );
      })}
      {remaining > 0 ? (
        <Text color={scheme.statusFg}>{`  … +${remaining} more`}</Text>
      ) : null}
    </Box>
  );
}
