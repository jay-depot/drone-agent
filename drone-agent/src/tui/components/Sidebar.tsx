/**
 * Right sidebar for the TUI.
 *
 * Renders a 25-character-wide sidebar on the right edge of the screen.
 * It appears only when:
 *   1. The terminal is at least 75 columns wide.
 *   2. At least one registered widget returns non-empty content.
 *
 * Each widget gets a section: a header line with its label, then its
 * content lines (one per array element). Widgets with empty content
 * are skipped.
 */

import { Box, Text, useStdout } from 'ink';
import type { SidebarWidget } from '../types.js';
import type { DroneColorScheme } from '../theme.js';

const SIDEBAR_WIDTH = 25;
const MIN_TERMINAL_WIDTH = 75;

export function Sidebar({
  widgets,
  scheme,
}: {
  widgets: SidebarWidget[];
  scheme: DroneColorScheme;
}): JSX.Element | null {
  const { stdout } = useStdout();

  // Hide sidebar if terminal is too narrow
  if (stdout.columns < MIN_TERMINAL_WIDTH) {
    return null;
  }

  // Collect non-empty widget sections
  const sections: { label: string; content: string[] }[] = [];
  for (const widget of widgets) {
    const content = widget.getContent();
    if (content.length > 0) {
      sections.push({ label: widget.label, content });
    }
  }

  // Hide sidebar if no widget has content
  if (sections.length === 0) {
    return null;
  }

  return (
    <Box
      width={SIDEBAR_WIDTH}
      flexShrink={0}
      flexDirection="column"
      borderStyle="single"
      borderColor={scheme.border}
    >
      {sections.map((section, idx) => (
        <Box key={section.label} flexDirection="column">
          {idx > 0 ? <Text> </Text> : null}
          <Text color={scheme.primary} bold>
            {` ${section.label}`}
          </Text>
          {section.content.map((line, lineIdx) => (
            <Text key={lineIdx} color={scheme.info}>
              {line}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}