/**
 * Tail region — renders live-updating components above the <Static> scrollback.
 *
 * Each TailItem is a React component that re-renders as its state changes.
 * When an item is "done", it's removed from the tail and committed to <Static>
 * by the caller via `toEntry()`.
 *
 * The tail region sits between the scrollback and the mid panel, so in-flight
 * content is visible without polluting the scrollback history.
 */

import { Box } from 'ink';
import type { TailItem } from '../types.js';

export function TailRegion({
  items,
}: {
  items: TailItem[];
}): React.JSX.Element {
  if (items.length === 0) {
    return <></>;
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      {items.map(item => (
        <Box key={item.id} flexDirection="column">
          {item.component}
        </Box>
      ))}
    </Box>
  );
}
