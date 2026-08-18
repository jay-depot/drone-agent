/**
 * Chat log rendering for the TUI.
 *
 * Renders the committed log entries (anything that's "done" — past
 * reasoning, tool calls, tool results, assistant messages, system
 * messages) using `<Static>` so previous lines never reflow.
 *
 * Above the static area, a tail region renders live-updating items
 * (in-flight reasoning, tool calls, assistant messages) that are
 * committed to <Static> when they complete.
 *
 * When a committed entry carries a pre-rendered `node`, that node is
 * rendered inside <Static> (preserving the live component's formatting).
 * Otherwise the plain `text`/`kind` is rendered via renderEntry() — this
 * is the path used by plain log() lines that have no rich component.
 */

import { Box, Static, Text } from 'ink';
import { ColorTag, type DroneColorScheme } from '../theme.js';
import type { ChatEntry, TailItem } from '../types.js';
import { Markdown } from './Markdown.js';
import { TailRegion } from './TailRegion.js';

/** Separator rule placed under every user message, mirroring the top/bottom
 * padding around assistant responses for visual symmetry. */
const USER_SEPARATOR = '\n\n---\n\n';

export function ChatLog({
  entries,
  tailItems,
  scheme,
  syntaxColors,
  codeBackground,
}: {
  entries: ChatEntry[];
  /** Live-updating items rendered above the static area. */
  tailItems: TailItem[];
  scheme: DroneColorScheme;
  syntaxColors?: Record<string, string>;
  codeBackground?: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      <TailRegion items={tailItems} />
      <Static items={entries} style={{ width: '100%' }}>
        {entry => (
          <Box key={entry.id} flexDirection="column">
            {entry.node ??
              renderEntry(entry, scheme, syntaxColors, codeBackground)}
          </Box>
        )}
      </Static>
    </Box>
  );
}

function renderEntry(
  entry: ChatEntry,
  scheme: DroneColorScheme,
  syntaxColors?: Record<string, string>,
  codeBackground?: string
): React.JSX.Element {
  switch (entry.kind) {
    case 'user':
      return (
        <Text>
          <ColorTag color={scheme.userInput}>{'> '}</ColorTag>
          {entry.text}
          {USER_SEPARATOR}
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
    case 'compaction':
      return (
        <Text>
          <ColorTag color={scheme.compaction}>{entry.text}</ColorTag>
        </Text>
      );
   case 'notice':
     return (
       <Text italic>
         <ColorTag color={scheme.notice}>{entry.text}</ColorTag>
       </Text>
     );
    case 'markdown':
      return (
        <Markdown
          color={scheme.info}
          syntaxColors={syntaxColors}
          codeBackground={codeBackground}
        >
          {entry.text}
        </Markdown>
      );
    case 'plain':
    default:
      return <Text>{entry.text}</Text>;
  }
}
