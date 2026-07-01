import type React from 'react';
/**
 * Mid panel for the TUI.
 *
 * Renders a full-width horizontal bar between the chat log and the
 * input line. Each registered widget contributes a single-line
 * fragment separated by " │ " (pipe) spacers. Widgets with empty
 * content are skipped.
 */

import { Box, Text } from 'ink';
import type { MidPanelWidget } from '../types.js';
import type { DroneColorScheme } from '../theme.js';

export function MidPanel({
  widgets,
  scheme,
}: {
  widgets: MidPanelWidget[];
  scheme: DroneColorScheme;
}): React.JSX.Element | null {
  // Collect non-empty widget sections
  const sections: { label: string; content: string[] }[] = [];
  for (const widget of widgets) {
    if (typeof widget.getContent !== 'function') continue;
    const content = widget.getContent();
    if (content.length > 0) {
      sections.push({ label: widget.label, content });
    }
  }

  // Hide panel if no widget has content
  if (sections.length === 0) {
    return null;
  }

  return (
    <Box
      width="100%"
      flexDirection="row"
      borderStyle="single"
      borderColor={scheme.border}
      paddingX={1}
    >
      {sections.map((section, idx) => (
        <Box key={section.label} flexDirection="row">
          {idx > 0 ? <Text color={scheme.border}> │ </Text> : null}
          <Text color={scheme.primary} bold>
            {`${section.label}: `}
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
