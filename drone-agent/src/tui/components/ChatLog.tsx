/**
 * Chat log rendering for the TUI.
 *
 * Renders the committed log entries (anything that's "done" — past
 * reasoning, tool calls, tool results, assistant messages, system
 * messages) using `<Static>` so previous lines never reflow. Anything
 * currently in-flight (the last partial assistant message) goes in a
 * separate `tail` slot so it can update without re-rendering the rest.
 */

import { Box, Static, Text } from 'ink';
import type { ReactNode } from 'react';
import { ColorTag, type DroneColorScheme } from '../theme.js';
import type { ChatEntry } from '../types.js';

export type { ChatEntry };

export function ChatLog({
  entries,
  tail,
  scheme,
}: {
  entries: ChatEntry[];
  /** Optional in-flight line that should be rendered above the static area. */
  tail?: ReactNode;
  scheme: DroneColorScheme;
}): JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {tail}
      <Static items={entries} style={{ width: '100%' }}>
        {entry => (
          <Box key={entry.id} flexDirection="column">
            {renderEntry(entry, scheme)}
          </Box>
        )}
      </Static>
    </Box>
  );
}

function renderEntry(entry: ChatEntry, scheme: DroneColorScheme): JSX.Element {
  switch (entry.kind) {
    case 'user':
      return (
        <Text>
          <ColorTag color={scheme.userInput}>{'> '}</ColorTag>
          {entry.text}
        </Text>
      );
    case 'reasoning':
      return (
        <Text>
          <ColorTag color={scheme.reasoning}>{'💭 '}</ColorTag>
          <ColorTag color={scheme.reasoning}>{entry.text}</ColorTag>
        </Text>
      );
    case 'toolCall':
      return (
        <Text>
          <ColorTag color={scheme.toolCall}>{`→ ${entry.text}`}</ColorTag>
        </Text>
      );
    case 'toolResult':
      return (
        <Text>
          <ColorTag color={scheme.toolResult}>{`← ${entry.text}`}</ColorTag>
        </Text>
      );
    case 'error':
      return (
        <Text>
          <ColorTag color={scheme.error}>{entry.text}</ColorTag>
        </Text>
      );
    case 'info':
      return (
        <Text>
          <ColorTag color={scheme.info}>{entry.text}</ColorTag>
        </Text>
      );
    case 'success':
      return (
        <Text>
          <ColorTag color={scheme.success}>{entry.text}</ColorTag>
        </Text>
      );
    case 'plain':
    default:
      return <Text>{entry.text}</Text>;
  }
}
